// M38 — "lesson" added for cross-workflow lessons learned (EngineLesson rows
// surfaced as GLOBAL_LESSON prompt layers at assembly time).
export type RetrievedSourceKind = "knowledge" | "memory" | "symbol" | "artifact" | "lesson";

export interface RetrievedChunk {
  source_kind: RetrievedSourceKind;
  source_id: string;
  citation_key: string;
  excerpt: string;
  confidence: number;
  cosine_similarity?: number;
  fts_score?: number;
  rrf_rank?: number;
  age_days?: number;
  metadata?: Record<string, unknown>;
}
