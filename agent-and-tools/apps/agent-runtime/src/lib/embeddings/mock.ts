import { createHash } from "node:crypto";
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from "./types";

/**
 * Deterministic mock — vectors are seeded from sha256(text) so the same input
 * always yields the same vector. Keeps tests reproducible without hitting any
 * network. Default dim 384 (Sentence-BERT-ish) so it's distinguishable from
 * the real OpenAI/Ollama dims when inspecting rows.
 */

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock" as const;
  readonly defaultModel = "mock-deterministic-384";
  private dim: number;

  constructor(opts: { dim?: number } = {}) {
    this.dim = opts.dim ?? 384;
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const seed = createHash("sha256").update(req.text).digest();
    const vector: number[] = new Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      // Map each dim to a byte from sha256, normalised to [-1, 1).
      const byte = seed[i % seed.length];
      vector[i] = (byte / 255) * 2 - 1;
    }
    return {
      vector,
      provider: this.name,
      model: req.model ?? this.defaultModel,
      dim: this.dim,
      metadata: { deterministic: true },
    };
  }
}
