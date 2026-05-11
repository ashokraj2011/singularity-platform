import { createHash } from "node:crypto";
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from "./types";

/**
 * Deterministic mock — vectors are seeded from sha256(text) so the same input
 * always yields the same vector. Keeps tests reproducible without hitting any
 * network.
 *
 * M15 — default dim is now 1536 so the mock fits the pgvector(1536) column
 * the migration creates. Tests can override via `new MockEmbeddingProvider({dim:384})`.
 */

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock" as const;
  readonly defaultModel: string;
  private dim: number;

  constructor(opts: { dim?: number } = {}) {
    this.dim = opts.dim ?? 1536;
    this.defaultModel = `mock-deterministic-${this.dim}`;
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
