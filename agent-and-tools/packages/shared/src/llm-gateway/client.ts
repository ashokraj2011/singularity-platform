/**
 * M33 — Single LLM gateway client (TypeScript).
 *
 * EVERY service that needs an LLM call must use this client. Provider keys
 * live ONLY in the gateway. There is no provider fallback chain — if the
 * gateway returns non-2xx, the error propagates. The only allowed fallback
 * is the deterministic in-process `mock` mode, activated by setting
 * `LLM_GATEWAY_URL=mock` (used in unit tests).
 *
 * Env contract (every consumer service):
 *   LLM_GATEWAY_URL     required — http://llm-gateway:8001  | mock
 *   LLM_GATEWAY_BEARER  optional — service token for gateway auth
 *
 * M35.4 — request shapes are Zod-validated before POST. A malformed request
 * (no messages, wrong role, etc.) fails fast in the calling service with a
 * clear error instead of bouncing off the gateway with a 422.
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
});

const EmbeddingsRequestSchema = z.object({
  model_alias: z.string().min(1).optional(),
  input: z.array(z.string()).min(1, "input cannot be empty"),
  trace_id: z.string().optional(),
  capability_id: z.string().optional(),
});

const MOCK_SENTINEL = "mock";

function gatewayUrl(): string {
  const v = process.env.LLM_GATEWAY_URL?.trim();
  if (!v) {
    throw new Error(
      "LLM_GATEWAY_URL is not set. Every service must route LLM calls through the central " +
      "gateway. Set LLM_GATEWAY_URL=http://llm-gateway:8001 in container env, or =mock for tests.",
    );
  }
  return v;
}

function gatewayBearer(): string | undefined {
  return process.env.LLM_GATEWAY_BEARER?.trim() || undefined;
}

function gatewayTimeoutMs(): number {
  const raw = process.env.LLM_GATEWAY_TIMEOUT_SEC;
  const n = raw ? Number(raw) : 240;
  return Math.max(1, n) * 1000;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const url = gatewayUrl();
  if (url === MOCK_SENTINEL) {
    // In-process mock — used only by unit tests that don't want a live gateway.
    // Resolved via dynamic import to keep `mock` opt-in (no runtime cost in prod).
    const { mockHandle } = await import("./mock-handler");
    return mockHandle(path, body) as Promise<T>;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bearer = gatewayBearer();
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(gatewayTimeoutMs()),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LLM gateway ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`LLM gateway ${path} returned malformed JSON: ${(err as Error).message}`);
  }
}

/** One-shot chat completion call through the central gateway. */
export async function llmRespond(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  // M35.4 — fail-fast validation before the wire call. Clear error from the
  // calling service beats a generic 422 from the gateway with no context.
  const validation = ChatCompletionRequestSchema.safeParse(req);
  if (!validation.success) {
    const issues = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`llm gateway request validation failed: ${issues}`);
  }
  // Additional sanity check: tools without a system or user message means
  // the model has nothing to respond to. Easy to hit when callers compose
  // the request lazily and forget to seed the conversation.
  if (req.tools && req.tools.length > 0 && req.messages.length < 1) {
    throw new Error(
      `llm gateway request invalid: tools provided (${req.tools.length}) but messages is empty — the model has nothing to act on`,
    );
  }
  return post<ChatCompletionResponse>("/v1/chat/completions", req);
}

/** Batched embeddings call through the central gateway. */
export async function llmEmbed(req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
  // M35.4 — fail-fast validation before the wire call.
  const validation = EmbeddingsRequestSchema.safeParse(req);
  if (!validation.success) {
    const issues = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`llm gateway embeddings validation failed: ${issues}`);
  }
  return post<EmbeddingsResponse>("/v1/embeddings", req);
}

/** True iff env tells us to short-circuit to the in-process mock. */
export function isGatewayMockMode(): boolean {
  return (process.env.LLM_GATEWAY_URL ?? "").trim() === MOCK_SENTINEL;
}
