/**
 * M25 / M25.5 / M25.6 — Composable Retriever primitives for prompt-composer.
 *
 * One file holds: the typed `RetrievedChunk` shape, the cite-marker formatter
 * for grounded LLM responses, the Reciprocal Rank Fusion helper for hybrid
 * (vector + FTS) retrieval, and the taskSignature hash for capsule caching.
 *
 * Only the artifact + memory tables are in scope (per the M27 reconciliation):
 * code symbols moved into the mcp-server local AST index, which lives
 * wherever mcp-server runs (laptop, customer VPC, shared dev host).
 */
import { createHash } from "node:crypto";

// ── Typed retrieval shape (M25) ────────────────────────────────────────────
//
// Every retrieved row gets wrapped in this. citation_key is a stable,
// human-readable handle the LLM can preserve in its output via cite markers.
// excerpt is content.slice(0, 500) so PromptAssembly.evidenceRefs stays small
// even when the underlying artifact body is multi-MB.
export type SourceKind = "knowledge" | "memory" | "symbol" | "artifact";

export interface RetrievedChunk {
  source_kind:        SourceKind;
  source_id:          string;
  citation_key:       string;
  excerpt:            string;                   // content.slice(0, 500)
  confidence:         number;                   // 0..1, clamped final score
  cosine_similarity?: number;
  fts_score?:         number;
  rrf_rank?:          number;
  age_days?:          number;
  metadata?:          Record<string, unknown>;
}

const EXCERPT_MAX = 500;

export function makeCitationKey(kind: SourceKind, title: string, id: string): string {
  const t = (title || "").trim().slice(0, 60).replace(/[\s\n]+/g, " ");
  return `${kindPrefix(kind)}:${t || "untitled"}#${id.slice(0, 6)}`;
}

function kindPrefix(k: SourceKind): string {
  if (k === "knowledge") return "KA";
  if (k === "memory")    return "DM";
  if (k === "symbol")    return "CS";
  return "AR";
}

export function toExcerpt(content: string): string {
  if (!content) return "";
  if (content.length <= EXCERPT_MAX) return content;
  return content.slice(0, EXCERPT_MAX) + "…";
}

// M25 — cite markers use non-markdown unicode brackets so renderers can't
// mangle them and content with literal `[` / `]` doesn't collide.
export function formatCiteMarker(key: string): string {
  return `〔cite: ${key}〕`;
}

// ── Reciprocal Rank Fusion (M25.6) ─────────────────────────────────────────
//
// Fuses two ranked lists (vector + FTS) without normalising scores from
// different scales. k=60 is the conventional RRF constant (Cormack et al.).
export const RRF_K = 60;

export interface RankedHit<T> { id: string; row: T; rank: number; }

export function reciprocalRankFusion<T>(
  vectorRanked: Array<{ id: string; row: T }>,
  ftsRanked:    Array<{ id: string; row: T }>,
  k = RRF_K,
): Array<{ id: string; row: T; rrf_score: number; vector_rank: number | null; fts_rank: number | null }> {
  const score = new Map<string, number>();
  const row   = new Map<string, T>();
  const vRank = new Map<string, number>();
  const fRank = new Map<string, number>();
  vectorRanked.forEach((r, i) => {
    score.set(r.id, (score.get(r.id) ?? 0) + 1 / (k + i + 1));
    row.set(r.id, r.row);
    vRank.set(r.id, i + 1);
  });
  ftsRanked.forEach((r, i) => {
    score.set(r.id, (score.get(r.id) ?? 0) + 1 / (k + i + 1));
    if (!row.has(r.id)) row.set(r.id, r.row);
    fRank.set(r.id, i + 1);
  });
  return Array.from(score.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, s]) => ({
      id, row: row.get(id) as T, rrf_score: s,
      vector_rank: vRank.get(id) ?? null,
      fts_rank:    fRank.get(id) ?? null,
    }));
}

// ── Hybrid score with recency (M25.6) ──────────────────────────────────────
const RECENCY_BOOST_DAYS = Number(process.env.EMBEDDING_RECENCY_DAYS ?? 30);
const RECENCY_BOOST_MAX  = Number(process.env.EMBEDDING_RECENCY_BOOST ?? 0.2);

export function recencyBoost(ageDays: number): number {
  if (ageDays >= RECENCY_BOOST_DAYS) return 0;
  if (ageDays <= 0) return RECENCY_BOOST_MAX;
  return ((RECENCY_BOOST_DAYS - ageDays) / RECENCY_BOOST_DAYS) * RECENCY_BOOST_MAX;
}

export function clampConfidence(x: number): number {
  if (!isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// ── Retrieval mode env flag (M25.6) ────────────────────────────────────────
export type RetrievalMode = "hybrid" | "vector" | "fts";
export function retrievalMode(): RetrievalMode {
  const raw = String(process.env.RETRIEVAL_MODE ?? "hybrid").toLowerCase();
  if (raw === "vector" || raw === "fts") return raw;
  return "hybrid";
}

// ── M25.5 — Context Compiler cache key ─────────────────────────────────────
//
// taskSignature ties a cache entry to: which capability, which agent template,
// the normalized intent (whitespace-collapsed task), and the per-capability
// content revision (so any artifact/memory change invalidates the capsule).
// Caller passes the revision they pulled from the capability — keeping it
// outside this helper makes the function pure + testable.
export function normalizeIntent(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 4000);
}

export function taskSignature(parts: {
  capabilityId:    string;
  agentTemplateId: string;
  intent:          string;
  contentRevision: string;
}): string {
  const h = createHash("sha256");
  h.update("v1\n");
  h.update(parts.capabilityId + "\n");
  h.update(parts.agentTemplateId + "\n");
  h.update(normalizeIntent(parts.intent) + "\n");
  h.update(parts.contentRevision + "\n");
  return h.digest("hex");
}

// ── Composer toggles for M25.7 wind-down ───────────────────────────────────
export function includeCodeContext(): boolean {
  // M27 moved code symbols into mcp-server's local AST index — wherever
  // mcp-server runs (laptop, customer VPC, shared dev host). Composer's
  // CODE_CONTEXT layer is now opt-in. Set PROMPT_INCLUDE_CODE_CONTEXT=true
  // to bring it back (legacy parity for capabilities that pre-date M27).
  return String(process.env.PROMPT_INCLUDE_CODE_CONTEXT ?? "false").toLowerCase() === "true";
}
