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
 */
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
} from "./types";

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
  return post<ChatCompletionResponse>("/v1/chat/completions", req);
}

/** Batched embeddings call through the central gateway. */
export async function llmEmbed(req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
  return post<EmbeddingsResponse>("/v1/embeddings", req);
}

/** True iff env tells us to short-circuit to the in-process mock. */
export function isGatewayMockMode(): boolean {
  return (process.env.LLM_GATEWAY_URL ?? "").trim() === MOCK_SENTINEL;
}
