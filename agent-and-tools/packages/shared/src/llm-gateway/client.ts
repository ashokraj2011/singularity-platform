/**
 * MCP-routed LLM client (TypeScript).
 *
 * By default every non-MCP service routes LLM calls through MCP (provider keys +
 * gateway URLs live outside caller services; MCP is the gateway client). Two
 * opt-outs: (1) `MCP_SERVER_URL=mock` — deterministic in-process mock for tests;
 * (2) D1 direct-to-gateway — set `LLM_GATEWAY_URL` (+ `LLM_GATEWAY_BEARER`) to skip
 * the mcp relay and call the central LLM gateway over HTTP directly, so grounding
 * embeddings/LLM calls don't depend on the mcp/laptop dial-in bridge. Secrets stay
 * centralized at the gateway either way — do NOT put provider keys in callers.
 *
 * Env contract (every consumer service):
 *   MCP_SERVER_URL      optional — http://mcp-server:7100 | mock
 *   MCP_BEARER_TOKEN    optional — service token for MCP auth
 *   LLM_GATEWAY_URL     optional — http://llm-gateway:8080 (D1: bypass the relay)
 *   LLM_GATEWAY_BEARER  optional — gateway bearer for the direct path
 *
 * M35.4 — request shapes are Zod-validated before POST. A malformed request
 * (no messages, wrong role, etc.) fails fast in the calling service.
 */
import { z } from "zod";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
} from "./types";

// ── M35.4 — Zod schemas mirroring ./types.ts ────────────────────────────
const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  tool_call_id: z.string().optional(),
  tool_name: z.string().optional(),
});

const ToolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  input_schema: z.record(z.unknown()),
});

// Task identity — WHAT the call is for. Declared here so it survives Zod
// validation and reaches the gateway's policy engine, which routes on it.
// Without these three fields a TS caller had exactly one way to express intent
// (name a model), which is the whole reason the platform grew twenty-odd
// `*_MODEL_ALIAS` env vars.
const TaskIdentityShape = {
  task_tag: z.string().min(1).optional(),
  stage: z.string().min(1).optional(),
  purpose: z.string().min(1).optional(),
};

const ChatCompletionRequestSchema = z.object({
  model_alias: z.string().min(1).optional(),
  messages: z.array(ChatMessageSchema).min(1, "messages cannot be empty"),
  tools: z.array(ToolDescriptorSchema).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  trace_id: z.string().optional(),
  run_id: z.string().optional(),
  capability_id: z.string().optional(),
  ...TaskIdentityShape,
});

const EmbeddingsRequestSchema = z.object({
  model_alias: z.string().min(1).optional(),
  input: z.array(z.string()).min(1, "input cannot be empty"),
  trace_id: z.string().optional(),
  capability_id: z.string().optional(),
  ...TaskIdentityShape,
});

const MOCK_SENTINEL = "mock";

type McpInvokeData = {
  status?: string;
  finalResponse?: string;
  finishReason?: string;
  tokensUsed?: {
    input?: number;
    output?: number;
    total?: number;
  };
  modelUsage?: {
    provider?: string;
    model?: string;
    modelAlias?: string;
    inputTokens?: number;
    outputTokens?: number;
  };
};

type McpInvokeEnvelope = {
  success?: boolean;
  data?: McpInvokeData;
};

type McpEmbedEnvelope = {
  success?: boolean;
  data?: EmbeddingsResponse;
};

type JsonObject = Record<string, unknown>;

function mcpUrl(): string {
  return (process.env.MCP_SERVER_URL?.trim() || "http://mcp-server:7100").replace(/\/$/, "");
}

function mcpBearer(): string | undefined {
  return process.env.MCP_BEARER_TOKEN?.trim() || undefined;
}

function mcpTimeoutMs(): number {
  const raw = process.env.MCP_TIMEOUT_SEC;
  const n = raw ? Number(raw) : 240;
  return Math.max(1, n) * 1000;
}

// ── D1 — direct-to-gateway transport (grounding without the mcp relay) ─────────
// When LLM_GATEWAY_URL is set, embeddings/LLM calls go straight to the central LLM
// gateway over HTTP instead of relaying through mcp-server, so grounding no longer
// depends on the mcp/laptop dial-in bridge. Secrets stay centralized at the gateway
// (LLM_GATEWAY_BEARER) — never spread provider keys to callers. Unset → the mcp
// relay (default). Mock mode still wins. The gateway's /v1/embeddings and
// /v1/chat/completions responses are wire-identical to EmbeddingsResponse /
// ChatCompletionResponse, so the direct path is a passthrough.
function gatewayDirectUrl(): string | undefined {
  const raw = process.env.LLM_GATEWAY_URL?.trim();
  return raw ? raw.replace(/\/$/, "") : undefined;
}

function gatewayDirectHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bearer = process.env.LLM_GATEWAY_BEARER?.trim() || process.env.LLM_GATEWAY_TOKEN?.trim();
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return headers;
}

function splitMessages(messages: ChatCompletionRequest["messages"]): {
  systemPrompt?: string;
  history: ChatCompletionRequest["messages"];
  message: string;
} {
  const systemPrompt = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
    .trim();
  const conversational = messages.filter((m) => m.role !== "system");
  const lastUserIndex = [...conversational].map((m) => m.role).lastIndexOf("user");
  const messageIndex = lastUserIndex >= 0 ? lastUserIndex : conversational.length - 1;
  const chosen = conversational[messageIndex];
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    history: conversational.filter((_, index) => index !== messageIndex),
    message: chosen?.content ?? "Continue.",
  };
}

function normalizeFinishReason(reason: string | undefined): ChatCompletionResponse["finish_reason"] {
  if (reason === "stop" || reason === "tool_call" || reason === "length" || reason === "error") return reason;
  if (reason === "max_steps") return "length";
  return "error";
}

// KNOWN GAP — the mcp relay does not carry task identity. `/mcp/invoke` takes a
// nested {modelConfig, runContext} shape with no home for task_tag/stage/purpose,
// and mcp-server's own gateway client hardcodes `task_tag: "agent_turn"` on the
// far side. So a caller that declares `task_tag: "summarise"` and reaches the
// gateway VIA the relay is billed as an agent turn. Only the D1 direct path
// (LLM_GATEWAY_URL set) preserves the caller's declared tag today. Closing this
// means widening the /mcp/invoke contract, which is a bigger blast radius than
// collapsing env vars — deliberately left for its own change.
async function invokeMcp(req: ChatCompletionRequest): Promise<McpInvokeData> {
  const url = mcpUrl();
  if (url === MOCK_SENTINEL) {
    const { mockHandle } = await import("./mock-handler");
    const mock = await mockHandle("chat", req) as ChatCompletionResponse;
    return {
      status: "COMPLETED",
      finalResponse: mock.content,
      finishReason: mock.finish_reason,
      tokensUsed: { input: mock.input_tokens, output: mock.output_tokens },
      modelUsage: {
        provider: mock.provider,
        model: mock.model,
        modelAlias: mock.model_alias,
        inputTokens: mock.input_tokens,
        outputTokens: mock.output_tokens,
      },
    };
  }
  const { systemPrompt, history, message } = splitMessages(req.messages);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bearer = mcpBearer();
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${url}/mcp/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...(systemPrompt ? { systemPrompt } : {}),
      history,
      message,
      tools: req.tools ?? [],
      modelConfig: {
        ...(req.model_alias ? { modelAlias: req.model_alias } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.max_output_tokens !== undefined ? { maxTokens: req.max_output_tokens } : {}),
      },
      runContext: {
        traceId: req.trace_id,
        runId: req.run_id,
        capabilityId: req.capability_id,
      },
      limits: {
        maxSteps: req.tools?.length ? 6 : 1,
        timeoutSec: Math.ceil(mcpTimeoutMs() / 1000),
        compressToolResults: true,
        includeLocalTools: false,
      },
    }),
    signal: AbortSignal.timeout(mcpTimeoutMs()),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP /mcp/invoke -> ${res.status}: ${text.slice(0, 500)}`);
  }
  const envelope = parseMcpEnvelope(text, "MCP /mcp/invoke") as McpInvokeEnvelope;
  if (envelope.success === false) {
    throw new Error("MCP returned success=false");
  }
  if (!isPlainObject(envelope.data)) {
    throw new Error("MCP /mcp/invoke returned no invocation data");
  }
  return envelope.data as McpInvokeData;
}

/** One-shot chat completion call through MCP. */
export async function llmRespond(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  // M35.4 — fail-fast validation before the wire call. Clear error from the
  // calling service beats a generic 422 from MCP with no context.
  const validation = ChatCompletionRequestSchema.safeParse(req);
  if (!validation.success) {
    const issues = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`MCP-routed LLM request validation failed: ${issues}`);
  }
  // Additional sanity check: tools without a system or user message means
  // the model has nothing to respond to. Easy to hit when callers compose
  // the request lazily and forget to seed the conversation.
  if (req.tools && req.tools.length > 0 && req.messages.length < 1) {
    throw new Error(
      `MCP-routed LLM request invalid: tools provided (${req.tools.length}) but messages is empty — the model has nothing to act on`,
    );
  }
  const directUrl = gatewayDirectUrl();
  if (directUrl && mcpUrl() !== MOCK_SENTINEL) {
    // D1 — direct-to-gateway (skip the mcp relay). Wire-identical response shape.
    const res = await fetch(`${directUrl}/v1/chat/completions`, {
      method: "POST",
      headers: gatewayDirectHeaders(),
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(mcpTimeoutMs()),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LLM gateway /v1/chat/completions -> ${res.status}: ${text.slice(0, 500)}`);
    return parseMcpEnvelope(text, "LLM gateway /v1/chat/completions") as unknown as ChatCompletionResponse;
  }
  const data = await invokeMcp(req);
  const inputTokens = data.tokensUsed?.input ?? data.modelUsage?.inputTokens ?? 0;
  const outputTokens = data.tokensUsed?.output ?? data.modelUsage?.outputTokens ?? 0;
  return {
    content: data.finalResponse ?? "",
    finish_reason: normalizeFinishReason(data.finishReason),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    latency_ms: 0,
    provider: data.modelUsage?.provider ?? "mcp",
    model: data.modelUsage?.model ?? req.model_alias ?? "mcp-default",
    model_alias: data.modelUsage?.modelAlias ?? req.model_alias,
  };
}

/** Batched embeddings call through MCP. */
export async function llmEmbed(req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
  // M35.4 — fail-fast validation before the wire call.
  const validation = EmbeddingsRequestSchema.safeParse(req);
  if (!validation.success) {
    const issues = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`MCP-routed embeddings validation failed: ${issues}`);
  }
  if (mcpUrl() === MOCK_SENTINEL) {
    const { mockHandle } = await import("./mock-handler");
    return mockHandle("embeddings", req) as Promise<EmbeddingsResponse>;
  }
  const directUrl = gatewayDirectUrl();
  if (directUrl) {
    // D1 — direct-to-gateway (skip the mcp relay). Wire-identical response shape.
    //
    // The body is `req` wholesale, matching llmRespond. It used to be rebuilt
    // field-by-field as `{input, model_alias?}`, which silently dropped
    // trace_id and capability_id — and would have dropped task_tag too, so a
    // caller that stopped pinning an alias and started declaring its task would
    // have arrived at the gateway carrying neither. An allowlist that has to be
    // updated every time the wire type grows a field is a drop waiting to happen;
    // the request type IS the allowlist.
    const res = await fetch(`${directUrl}/v1/embeddings`, {
      method: "POST",
      headers: gatewayDirectHeaders(),
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(mcpTimeoutMs()),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LLM gateway /v1/embeddings -> ${res.status}: ${text.slice(0, 500)}`);
    return parseMcpEnvelope(text, "LLM gateway /v1/embeddings") as unknown as EmbeddingsResponse;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bearer = mcpBearer();
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${mcpUrl()}/mcp/embed`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...(req.model_alias ? { modelAlias: req.model_alias } : {}),
      input: req.input,
      runContext: {
        traceId: req.trace_id,
        capabilityId: req.capability_id,
      },
    }),
    signal: AbortSignal.timeout(mcpTimeoutMs()),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP /mcp/embed -> ${res.status}: ${text.slice(0, 500)}`);
  }
  const envelope = parseMcpEnvelope(text, "MCP /mcp/embed") as McpEmbedEnvelope;
  if (envelope.success === false || !isPlainObject(envelope.data)) {
    throw new Error("MCP /mcp/embed returned no embedding data");
  }
  return envelope.data;
}

/** True iff env tells us to short-circuit to the in-process mock. */
export function isGatewayMockMode(): boolean {
  return (process.env.MCP_SERVER_URL ?? "").trim() === MOCK_SENTINEL;
}

function parseMcpEnvelope(text: string, upstream: string): JsonObject {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error("response was not a JSON object");
    }
    return parsed;
  } catch (err) {
    const detail = err instanceof SyntaxError
      ? responseSnippet(text) || err.message
      : (err as Error).message;
    throw new Error(`${upstream} returned malformed JSON: ${detail}`);
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function responseSnippet(text: string, max = 400): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}
