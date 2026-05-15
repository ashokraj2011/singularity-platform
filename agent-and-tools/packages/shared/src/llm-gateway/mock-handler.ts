/**
 * M33 — In-process mock handler for tests.
 *
 * Activated by `LLM_GATEWAY_URL=mock`. Returns deterministic responses
 * shaped exactly like the gateway's mock provider. Tests can run without a
 * live gateway container.
 */
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
} from "./types";
import { createHash } from "node:crypto";

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function mockChat(req: ChatCompletionRequest): ChatCompletionResponse {
  const inputText = req.messages.map((m) => m.content || "").join("\n");
  const reply = `[mock] Received ${req.messages.length} message(s) (${inputText.length} chars). No tool call needed.`;
  return {
    content: reply,
    finish_reason: "stop",
    input_tokens: approxTokens(inputText),
    output_tokens: approxTokens(reply),
    latency_ms: 1,
    provider: "mock",
    model: req.model || "mock-fast",
    model_alias: req.model_alias,
  };
}

function mockEmbed(req: EmbeddingsRequest): EmbeddingsResponse {
  const dim = 1536;
  const vectors = req.input.map((text) => {
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
  });
  return {
    embeddings: vectors,
    dim,
    provider: "mock",
    model: req.model || "mock-embed",
    model_alias: req.model_alias,
    input_tokens: req.input.reduce((n, t) => n + approxTokens(t), 0),
    latency_ms: 0,
  };
}

export async function mockHandle(path: string, body: unknown): Promise<unknown> {
  if (path === "/v1/chat/completions") return mockChat(body as ChatCompletionRequest);
  if (path === "/v1/embeddings")       return mockEmbed(body as EmbeddingsRequest);
  throw new Error(`mock gateway has no handler for ${path}`);
}
