/**
 * M33 — MCP server's LLM client is now a thin wrapper around the central
 * LLM gateway. Provider keys live on `llm-gateway-service`; mcp-server only
 * holds an `LLM_GATEWAY_URL` + optional `LLM_GATEWAY_BEARER`. There is no
 * provider fallback chain — gateway errors propagate. The only allowed
 * fallback is the gateway's `mock` provider (or `LLM_GATEWAY_URL=mock`
 * for in-process unit tests).
 */
import { createHash } from "node:crypto";
import {
  EmbeddingsRequest,
  EmbeddingsResponse,
  LlmRequest,
  LlmResponse,
  LlmStreamHooks,
  PromptCacheRequest,
  PromptCacheUsage,
  ToolCall,
} from "./types";
import { config } from "../config";
import { log } from "../shared/log";
import {
  SUPPORTED_PROVIDERS,
  isProviderAllowedByConfig,
  loadProviderConfig,
  providerDefaultModel,
  providerSettings,
} from "./provider-config";
import { readUpstreamJsonBody, upstreamSnippet } from "../lib/upstream-json";


export function isProviderAllowed(provider: string): boolean {
  return isProviderAllowedByConfig(provider);
}


interface GatewayChatRequest {
  model_alias?: string;
  messages: LlmRequest["messages"];
  tools?: LlmRequest["tools"];
  temperature?: number;
  max_output_tokens?: number;
  prompt_cache?: LlmRequest["prompt_cache"];
  // What this call is FOR. This leg carries composed agent turns, so the tag is
  // fixed here rather than threaded from every caller — anything reaching the
  // gateway through mcp-server is an agent turn by construction.
  task_tag?: string;
}

interface GatewayChatResponse {
  content: string;
  tool_calls?: ToolCall[];
  finish_reason: LlmResponse["finish_reason"];
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  provider: string;
  model: string;
  model_alias?: string;
  estimated_cost?: number;
  prompt_cache?: PromptCacheUsage;
  promptCache?: PromptCacheUsage;
}

type GatewayEmbeddingsRequest = EmbeddingsRequest;
type GatewayEmbeddingsResponse = EmbeddingsResponse;

function normalizePromptCacheUsage(
  result: Pick<GatewayChatResponse, "prompt_cache" | "promptCache">,
  requested?: PromptCacheRequest,
): PromptCacheUsage | undefined {
  const providerUsage = result.prompt_cache ?? result.promptCache;
  if (providerUsage && typeof providerUsage === "object" && !Array.isArray(providerUsage)) {
    return {
      ...(requested ?? {}),
      ...providerUsage,
      reported: providerUsage.reported ?? true,
    };
  }
  if (requested?.enabled) {
    return {
      ...requested,
      reported: false,
    };
  }
  return undefined;
}

function gatewayUrl(): string {
  return config.LLM_GATEWAY_URL.trim();
}

async function parseGatewayJson<T>(res: Response, upstreamStatus: number | null, path: string): Promise<T> {
  const body = await readUpstreamJsonBody(res);
  if (!body.parseError) return body.data as T;
  const snippet = body.raw.trim() ? upstreamSnippet(body.raw, 500) : "empty response body";
  throw makeGatewayError(
    "LLM_GATEWAY_INVALID_RESPONSE",
    `LLM gateway ${path} returned invalid JSON (${body.parseError}): ${snippet}`,
    { upstreamStatus },
  );
}

function gatewayErrorCodeForStatus(status: number, text: string): string {
  if (status === 529 || /529/.test(text)) return "LLM_PROVIDER_OVERLOADED";
  if (status === 502 && /529/.test(text)) return "LLM_PROVIDER_OVERLOADED";
  if (status === 503) return "LLM_PROVIDER_UNAVAILABLE";
  if (status === 429) return "LLM_PROVIDER_RATE_LIMITED";
  if (status === 504) return "LLM_GATEWAY_TIMEOUT";
  return "LLM_GATEWAY_UPSTREAM";
}

async function callGateway(rawBody: GatewayChatRequest): Promise<GatewayChatResponse> {
  const body: GatewayChatRequest = { task_tag: "agent_turn", ...rawBody };
  const url = gatewayUrl();
  if (url === "mock") {
    // In-process deterministic mock for unit tests / smoke runs that don't
    // want a live gateway. Shaped identically to the gateway's mock provider.
    const inputText = body.messages.map((m) => m.content ?? "").join("\n");
    const reply = `[mock] Received ${body.messages.length} message(s) (${inputText.length} chars). No tool call needed.`;
    return {
      content: reply,
      finish_reason: "stop",
      input_tokens: Math.max(1, Math.ceil(inputText.length / 4)),
      output_tokens: Math.max(1, Math.ceil(reply.length / 4)),
      latency_ms: 1,
      provider: "mock",
      model: body.model_alias || "mock-fast",
      model_alias: body.model_alias,
      estimated_cost: 0,
    };
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.LLM_GATEWAY_BEARER) headers.authorization = `Bearer ${config.LLM_GATEWAY_BEARER}`;
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.LLM_GATEWAY_TIMEOUT_SEC * 1000),
    });
  } catch (err) {
    // M64 — Classify the abort/timeout case explicitly. Without this,
    // a gateway timeout surfaces as an opaque `AbortError` and the
    // context-fabric wrapper labels it MCP_INVOKE_FAILED.
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
      throw makeGatewayError(
        "LLM_GATEWAY_TIMEOUT",
        `LLM gateway did not respond within ${config.LLM_GATEWAY_TIMEOUT_SEC}s. ` +
          `If the gateway is mid-retry of an Anthropic 529, raise LLM_GATEWAY_TIMEOUT_SEC ` +
          `above the gateway's retry envelope ` +
          `(LLM_GATEWAY_RATE_LIMIT_RETRIES × LLM_GATEWAY_RATE_LIMIT_RETRY_DELAY_SEC).`,
        { upstreamStatus: null },
      );
    }
    // Network errors (DNS fail, connection refused, etc.).
    throw makeGatewayError("LLM_GATEWAY_UNREACHABLE", `LLM gateway unreachable: ${(err as Error).message}`, { upstreamStatus: null });
  }
  if (!res.ok) {
    const text = await res.text();
    // M64 — Map the HTTP status to a specific operator-actionable code.
    // The gateway already classifies these statuses (529 = Anthropic
    // overloaded, 503 = upstream down) AFTER its retry layer gave up.
    // We just need to surface them through the chain so the workbench
    // shows the operator the right "retry vs investigate vs escalate"
    // action instead of generic MCP_INVOKE_FAILED.
    const code = gatewayErrorCodeForStatus(res.status, text);
    throw makeGatewayError(code, `LLM gateway ${res.status}: ${text.slice(0, 500)}`, { upstreamStatus: res.status });
  }
  return parseGatewayJson<GatewayChatResponse>(res, res.status, "/v1/chat/completions");
}

/**
 * M64 — Structured gateway-error envelope. Extends AppError so the
 * mcp-server errorMiddleware preserves the code through to the HTTP
 * response body instead of collapsing to generic INTERNAL_ERROR.
 *
 * Code taxonomy (read by context-fabric → workbench → operator):
 *   LLM_PROVIDER_OVERLOADED   — Anthropic 529 (or 502 wrapping a 529).
 *                               Operator action: retry; if persistent,
 *                               raise gateway retry count.
 *   LLM_PROVIDER_UNAVAILABLE  — upstream 503. Investigate provider status.
 *   LLM_PROVIDER_RATE_LIMITED — upstream 429 after gateway retries
 *                               exhausted. Operator action: check budget /
 *                               increase TPM tier / wait.
 *   LLM_GATEWAY_TIMEOUT       — mcp-server's wait on the gateway hit
 *                               LLM_GATEWAY_TIMEOUT_SEC. Usually means
 *                               gateway is mid-retry and the timeout
 *                               is shorter than the retry envelope.
 *   LLM_GATEWAY_UNREACHABLE   — network error (DNS / ECONNREFUSED).
 *   LLM_GATEWAY_INVALID_RESPONSE — gateway returned 2xx with malformed JSON.
 *   LLM_GATEWAY_UPSTREAM      — other non-200 (fallback).
 */
import { AppError } from "../shared/errors";

const STATUS_BY_CODE: Record<string, number> = {
  LLM_PROVIDER_OVERLOADED:   529,
  LLM_PROVIDER_UNAVAILABLE:  503,
  LLM_PROVIDER_RATE_LIMITED: 429,
  LLM_GATEWAY_TIMEOUT:       504,
  LLM_GATEWAY_UNREACHABLE:   502,
  LLM_GATEWAY_INVALID_RESPONSE: 502,
  LLM_GATEWAY_UPSTREAM:      502,
};

export class GatewayError extends AppError {
  readonly upstreamStatus: number | null;
  constructor(code: string, message: string, upstreamStatus: number | null) {
    super(message, STATUS_BY_CODE[code] ?? 502, code, { upstreamStatus });
    this.name = "GatewayError";
    this.upstreamStatus = upstreamStatus;
  }
}

function makeGatewayError(code: string, message: string, opts: { upstreamStatus: number | null }): GatewayError {
  return new GatewayError(code, message, opts.upstreamStatus);
}

function mockEmbedding(text: string, dim = 1536): number[] {
  const digest = createHash("sha256").update(text).digest();
  const out: number[] = [];
  let i = 0;
  while (out.length < dim) {
    const slice = digest.subarray(i % digest.length, (i % digest.length) + 4);
    const raw = slice.length === 4
      ? slice.readUInt32BE(0)
      : Buffer.concat([slice, Buffer.alloc(4 - slice.length)]).readUInt32BE(0);
    out.push((raw % 10000) / 10000 - 0.5);
    i++;
  }
  return out;
}

async function callGatewayEmbeddings(body: GatewayEmbeddingsRequest): Promise<GatewayEmbeddingsResponse> {
  const url = gatewayUrl();
  if (url === "mock") {
    const embeddings = body.input.map((text) => mockEmbedding(text));
    return {
      embeddings,
      dim: embeddings[0]?.length ?? 1536,
      provider: "mock",
      model: body.model_alias || "mock-embed",
      model_alias: body.model_alias,
      input_tokens: body.input.reduce((sum, text) => sum + Math.max(1, Math.ceil(text.length / 4)), 0),
      latency_ms: 1,
    };
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.LLM_GATEWAY_BEARER) headers.authorization = `Bearer ${config.LLM_GATEWAY_BEARER}`;
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.LLM_GATEWAY_TIMEOUT_SEC * 1000),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
      throw makeGatewayError(
        "LLM_GATEWAY_TIMEOUT",
        `LLM gateway embeddings endpoint did not respond within ${config.LLM_GATEWAY_TIMEOUT_SEC}s.`,
        { upstreamStatus: null },
      );
    }
    throw makeGatewayError("LLM_GATEWAY_UNREACHABLE", `LLM gateway embeddings endpoint unreachable: ${(err as Error).message}`, { upstreamStatus: null });
  }
  if (!res.ok) {
    const text = await res.text();
    const code = gatewayErrorCodeForStatus(res.status, text);
    throw makeGatewayError(code, `LLM gateway embeddings ${res.status}: ${text.slice(0, 500)}`, { upstreamStatus: res.status });
  }
  return parseGatewayJson<GatewayEmbeddingsResponse>(res, res.status, "/v1/embeddings");
}


export async function llmRespond(req: LlmRequest, hooks?: LlmStreamHooks): Promise<LlmResponse> {
  const start = Date.now();
  const result = await callGateway({
    model_alias: req.model_alias,
    messages: req.messages,
    tools: req.tools,
    temperature: req.temperature,
    max_output_tokens: req.max_output_tokens,
    ...(req.prompt_cache?.enabled ? { prompt_cache: req.prompt_cache } : {}),
  });
  // Surface final content via onDelta for parity with the prior non-streaming
  // path. Gateway-side SSE is a follow-up.
  if (result.content && hooks?.onDelta) {
    await hooks.onDelta({ content: result.content });
  }
  return {
    content: result.content,
    tool_calls: result.tool_calls,
    finish_reason: result.finish_reason,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    latency_ms: result.latency_ms || (Date.now() - start),
    provider: result.provider,
    model: result.model,
    model_alias: result.model_alias,
    estimated_cost: result.estimated_cost,
    prompt_cache: normalizePromptCacheUsage(result, req.prompt_cache),
  };
}

export async function llmEmbed(req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
  const start = Date.now();
  const result = await callGatewayEmbeddings(req);
  return {
    ...result,
    latency_ms: result.latency_ms || (Date.now() - start),
  };
}


/** Used by /healthz and the GET /llm/providers route to surface which
 *  providers are configured. The gateway is the source of truth for
 *  credential presence; this view is enriched at boot by
 *  refreshGatewayProviderStatus() and falls back to "config-only" if the
 *  gateway is unreachable. */
export type ConfiguredProviderInfo = {
  name: string;
  ready: boolean;
  default_model: string;
  allowed: boolean;
  enabled: boolean;
  source: string;
  warnings: string[];
};


let cachedGatewayStatus: Record<string, { ready: boolean; warnings: string[] }> = {};
const LLM_PROVIDER_STATUS_TIMEOUT_MS = config.MCP_LLM_PROVIDER_STATUS_TIMEOUT_MS;

// Bug-fix (M-fix) — TTL-guarded lazy refresh. Before this, the cache was
// only ever populated by /healthz/strict, so the Operations Portal's
// /llm/models query always saw an empty cache → openai showed "Missing key"
// even when llm-gateway had the key and reported ready:true.
let lastRefreshedAt = 0;


export async function refreshGatewayProviderStatus(): Promise<void> {
  const url = gatewayUrl();
  if (!url || url === "mock") {
    cachedGatewayStatus = {};
    return;
  }
  try {
    const headers: Record<string, string> = {};
    if (config.LLM_GATEWAY_BEARER) headers.authorization = `Bearer ${config.LLM_GATEWAY_BEARER}`;
    const res = await fetch(`${url.replace(/\/$/, "")}/llm/providers`, {
      headers,
      signal: AbortSignal.timeout(LLM_PROVIDER_STATUS_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(`[llm] gateway /llm/providers returned ${res.status}; treating providers as enabled-only`);
      cachedGatewayStatus = {};
      return;
    }
    const body = await parseGatewayJson<{ providers?: Array<{ name: string; ready: boolean; warnings: string[] }> }>(
      res,
      res.status,
      "/llm/providers",
    );
    cachedGatewayStatus = {};
    for (const p of body.providers ?? []) {
      cachedGatewayStatus[p.name] = { ready: p.ready, warnings: p.warnings ?? [] };
    }
    // Mark the cache as fresh ONLY when the probe succeeded — failures keep
    // the old timestamp so the next request retries instead of waiting out the TTL.
    lastRefreshedAt = Date.now();
  } catch (err) {
    log.warn(`[llm] gateway probe failed: ${err instanceof Error ? err.message : String(err)}`);
    cachedGatewayStatus = {};
  }
}

/**
 * Bug-fix (M-fix) — Ensure the gateway-provider cache is no older than
 * `maxAgeMs`, re-probing if necessary. Called by /llm/models + /llm/providers
 * route handlers so a UI page-load reflects current key state without
 * waiting for /healthz/strict to be hit.
 *
 * TTL default 10s — short enough that a flipped env var becomes visible
 * fast, long enough that a hot UI doesn't hammer the gateway.
 */
export async function ensureFreshGatewayStatus(maxAgeMs = 10_000): Promise<void> {
  if (Date.now() - lastRefreshedAt < maxAgeMs) return;
  await refreshGatewayProviderStatus();
}


export function listConfiguredProviders(): ConfiguredProviderInfo[] {
  const loaded = loadProviderConfig();
  return SUPPORTED_PROVIDERS.map(provider => {
    const settings = providerSettings(provider);
    const allowed = isProviderAllowed(provider);
    const enabled = settings.enabled !== false;
    const gatewayInfo = cachedGatewayStatus[provider];
    const upstreamReady = gatewayInfo?.ready ?? (provider === "mock");
    const ready = Boolean(upstreamReady && enabled && allowed);
    const warnings: string[] = [];
    if (!enabled) warnings.push("Disabled by provider config.");
    if (!allowed) warnings.push("Blocked by provider allowlist.");
    if (gatewayInfo?.warnings?.length) warnings.push(...gatewayInfo.warnings);
    if (!gatewayInfo && provider !== "mock") {
      warnings.push("Credential presence is enforced by llm-gateway; not visible to mcp-server.");
    }
    return {
      name: provider,
      ready,
      default_model: providerDefaultModel(provider),
      allowed,
      enabled,
      source: loaded.source,
      warnings,
    };
  });
}
