/**
 * Embeddings dispatcher — picks a provider from `EMBEDDING_PROVIDER` env.
 *
 *   EMBEDDING_PROVIDER=openai (default if OPENAI_API_KEY is set)
 *   EMBEDDING_PROVIDER=ollama
 *   EMBEDDING_PROVIDER=mock   (default fallback when no API key — keeps dev unblocked)
 *
 * Per-provider config:
 *   OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_EMBEDDING_MODEL
 *   OLLAMA_BASE_URL, OLLAMA_EMBEDDING_MODEL
 *
 * Lazy-instantiated and cached so callers can `getEmbeddingProvider().embed(...)`
 * without tracking lifecycle.
 */
import { OpenAiEmbeddingProvider } from "./openai";
import { OllamaEmbeddingProvider } from "./ollama";
import { MockEmbeddingProvider } from "./mock";
import type { EmbeddingProvider, EmbeddingProviderName } from "./types";

let cached: EmbeddingProvider | undefined;

function pickProvider(): EmbeddingProviderName {
  const explicit = (process.env.EMBEDDING_PROVIDER ?? "").toLowerCase();
  if (explicit === "openai" || explicit === "ollama" || explicit === "mock") return explicit;
  if (process.env.OPENAI_API_KEY) return "openai";
  // Fallback to mock so dev environments don't crash. Logs a one-line warning
  // so it's obvious in the agent-runtime log on startup.
  // eslint-disable-next-line no-console
  console.warn(
    "[embeddings] no EMBEDDING_PROVIDER or OPENAI_API_KEY set — falling back to mock provider",
  );
  return "mock";
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;
  const name = pickProvider();
  switch (name) {
    case "openai":
      cached = new OpenAiEmbeddingProvider({
        apiKey: process.env.OPENAI_API_KEY ?? "",
        baseUrl: process.env.OPENAI_BASE_URL,
        defaultModel: process.env.OPENAI_EMBEDDING_MODEL,
      });
      break;
    case "ollama":
      cached = new OllamaEmbeddingProvider({
        baseUrl: process.env.OLLAMA_BASE_URL,
        defaultModel: process.env.OLLAMA_EMBEDDING_MODEL,
      });
      break;
    case "mock":
    default:
      cached = new MockEmbeddingProvider();
      break;
  }
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
