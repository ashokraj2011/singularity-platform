/**
 * M33 — Embeddings client. Single call path through the central LLM
 * gateway (`LLM_GATEWAY_URL`).
 *
 * The legacy auto-detection (EMBEDDING_PROVIDER → openai → mock) is gone:
 * provider keys live ONLY on the gateway. There is no provider fallback
 * chain — the gateway 502/503s propagate to the caller. The only allowed
 * fallback is `LLM_GATEWAY_URL=mock`, which short-circuits to a
 * deterministic in-process mock for unit tests.
 *
 * The legacy `EmbeddingProvider` interface (with `name`, `defaultModel`,
 * `.embed`) is preserved so call sites in compose.service.ts /
 * capability.service.ts continue to work. The "provider" returned by
 * `getEmbeddingProvider()` is now a thin adapter over `llmEmbed`.
 */
import { llmEmbed } from "../llm-gateway/client";
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse, EmbeddingProviderName } from "./types";

let cached: EmbeddingProvider | undefined;

class GatewayEmbeddingProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderName = "openai"; // wire-shape marker; gateway picks the real provider
  readonly defaultModel: string;

  constructor(defaultModel?: string) {
    this.defaultModel = defaultModel ?? "gateway-default";
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const start = Date.now();
    const result = await llmEmbed({
      model_alias: process.env.EMBEDDING_MODEL_ALIAS, // optional curated alias
      input: [req.text],
    });
    const vector = result.embeddings?.[0];
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("LLM gateway returned no embedding");
    }
    return {
      vector,
      provider: (result.provider as EmbeddingProviderName) ?? this.name,
      model: result.model,
      dim: vector.length,
      metadata: {
        latencyMs: Date.now() - start,
        promptTokens: result.input_tokens,
      },
    };
  }
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;
  cached = new GatewayEmbeddingProvider();
  return cached;
}

/** Test-only: lets a unit test inject a different provider without env juggling. */
export function _setEmbeddingProviderForTesting(p: EmbeddingProvider | undefined): void {
  cached = p;
}

// M15 — column dim is fixed at 1536 by the migration. Embedders that produce a
// different dim must be rejected at write time so we don't silently truncate.
export const REQUIRED_EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 1536);

export function assertDimMatches(dim: number, source: string): void {
  if (dim !== REQUIRED_EMBEDDING_DIM) {
    throw new Error(
      `[embeddings] dim mismatch from ${source}: got ${dim}, column expects ${REQUIRED_EMBEDDING_DIM}. ` +
      `Either change EMBEDDING_DIM/migration or pick a provider model that produces ${REQUIRED_EMBEDDING_DIM}-dim vectors.`,
    );
  }
}

/** Format a JS number[] as a pgvector literal (eg `'[0.1,0.2,...]'`). */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
