/**
 * M14 — shared embeddings client.
 *
 * Same shape across providers so call-sites don't care which model is wired.
 * Vector dimension is captured per-row at write time (`dim` in the response)
 * because we expect to swap models over time and want to detect mismatches
 * without re-embedding every row.
 */

export type EmbeddingProviderName = "openai" | "ollama" | "mock";

export interface EmbeddingRequest {
  /** Text to embed. */
  text: string;
  /** Optional model override; falls back to provider default. */
  model?: string;
}

export interface EmbeddingResponse {
  vector: number[];
  provider: EmbeddingProviderName;
  model: string;
  dim: number;
  /** Free-form provider notes (eg latency, token count). */
  metadata?: Record<string, unknown>;
}

export interface EmbeddingProvider {
  readonly name: EmbeddingProviderName;
  /** Default model identifier when the request doesn't override. */
  readonly defaultModel: string;
  embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}
