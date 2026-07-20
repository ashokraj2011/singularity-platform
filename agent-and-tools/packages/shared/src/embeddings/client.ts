/**
 * Embeddings client. Non-MCP services call MCP's embedding path; MCP is the
 * only component that talks to the LLM gateway.
 *
 * The legacy auto-detection (EMBEDDING_PROVIDER -> openai -> mock) is gone:
 * provider keys live only behind MCP/gateway. The only allowed fallback is
 * `MCP_SERVER_URL=mock`, which short-circuits to a deterministic in-process
 * mock for unit tests.
 *
 * The legacy `EmbeddingProvider` interface (with `name`, `defaultModel`,
 * `.embed`) is preserved so call sites in compose.service.ts /
 * capability.service.ts continue to work. The "provider" returned by
 * `getEmbeddingProvider()` is now a thin adapter over MCP-routed `llmEmbed`.
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
    // EMBEDDING_MODEL_ALIAS is still read, and still wins when set — an operator
    // who pinned an embedding model gets that model, because switching embedding
    // models silently is how a vector index ends up with two models' vectors in
    // it. What changed is the UNSET case: it now declares its task instead of
    // arriving anonymous, so the gateway routes it by policy rather than falling
    // back to whatever the global default alias happens to be.
    const modelAlias = process.env.EMBEDDING_MODEL_ALIAS?.trim();
    const result = await llmEmbed({
      input: [req.text],
      task_tag: "embedding",
      ...(modelAlias ? { model_alias: modelAlias } : {}),
    });
    const vector = result.embeddings?.[0];
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("MCP embedding path returned no embedding");
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

const DEFAULT_EMBEDDING_DIM = 1536;
const MIN_EMBEDDING_DIM = 1;
const MAX_EMBEDDING_DIM = 16_000;

export function boundedEmbeddingDim(raw = process.env.EMBEDDING_DIM): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_EMBEDDING_DIM;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_EMBEDDING_DIM) return DEFAULT_EMBEDDING_DIM;
  return Math.min(MAX_EMBEDDING_DIM, Math.trunc(parsed));
}

// M15 — column dim is fixed at 1536 by the migration. Embedders that produce a
// different dim must be rejected at write time so we don't silently truncate.
export const REQUIRED_EMBEDDING_DIM = boundedEmbeddingDim();

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
