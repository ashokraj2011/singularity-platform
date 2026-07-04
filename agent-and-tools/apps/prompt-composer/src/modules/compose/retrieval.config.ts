import { boundedIntEnv, boundedNumberEnv } from "../../shared/env-bounds";

export function retrievalConfig() {
  return {
    recencyBoostDays: boundedIntEnv("EMBEDDING_RECENCY_DAYS", 30, 1, 3650),
    recencyBoostMax: boundedNumberEnv("EMBEDDING_RECENCY_BOOST", 0.2, 0, 1),
    emptyFallbackCosineMin: boundedNumberEnv("RETRIEVAL_EMPTY_COSINE_THRESHOLD", 0.2, 0, 1),
  };
}
