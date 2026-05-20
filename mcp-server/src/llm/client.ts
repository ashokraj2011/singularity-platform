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

async function callGateway(body: GatewayChatRequest): Promise<GatewayChatResponse> {
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
  const res = await fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.LLM_GATEWAY_TIMEOUT_SEC * 1000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LLM_GATEWAY_UPSTREAM ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as GatewayChatResponse;
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
  const res = await fetch(`${url.replace(/\/$/, "")}/v1/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.LLM_GATEWAY_TIMEOUT_SEC * 1000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LLM_GATEWAY_EMBEDDINGS_UPSTREAM ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as GatewayEmbeddingsResponse;
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
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      log.warn(`[llm] gateway /llm/providers returned ${res.status}; treating providers as enabled-only`);
      cachedGatewayStatus = {};
      return;
    }
    const body = (await res.json()) as { providers?: Array<{ name: string; ready: boolean; warnings: string[] }> };
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
    const ready = gatewayInfo?.ready ?? (provider === "mock" && enabled && allowed);
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
