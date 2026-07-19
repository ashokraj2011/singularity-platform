/**
 * View response parsing — PURE, no I/O, fully unit-testable.
 *
 * Extracts the strict-JSON view document out of an LLM response and makes it
 * safe to store. Two guarantees matter more than the rest:
 *
 *  - PROVENANCE IS NOT SELF-CERTIFIED. An entry claiming `observed` while citing
 *    neither a file location nor an artifact is downgraded to inferred/low. A
 *    model that asserts "observed" with no source is guessing, and a downstream
 *    verifying agent must be able to trust that distinction.
 *  - LENGTH IS ENFORCED HERE, not hoped for. Views over their word cap are
 *    truncated at a word boundary, because an over-long view gets trimmed at
 *    inject time anyway — better to store what will actually be read.
 *
 * Fence-stripping and brace-slicing mirror parseEnrichment (bootstrap-phase3-
 * distill.ts) so both distillation paths tolerate the same model sloppiness.
 */

import { sha256, estimateTokens } from "../../shared/hash";
import type { ViewSpec } from "./world-model-view-specs";
import { projectEvidence, type EvidenceEntry } from "./world-model-views.types";

export type ParsedView = {
  title: string;
  contentMd: string;
  structured: Record<string, unknown> | null;
  evidence: EvidenceEntry[];
  tokenEstimate: number;
  contentHash: string;
  warnings: string[];
};

/** Strip a ```json fence, else slice the outermost JSON object. */
export function extractJsonBlock(raw: string): string {
  const text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

function countWords(text: string): number {
  const matched = text.trim().match(/\S+/g);
  return matched ? matched.length : 0;
}

/** Truncate to maxWords at a word boundary, flagging the cut in-band. */
export function truncateToWords(text: string, maxWords: number): { text: string; truncated: boolean } {
  const words = text.trim().match(/\S+/g);
  if (!words || words.length <= maxWords) return { text: text.trim(), truncated: false };
  return { text: `${words.slice(0, maxWords).join(" ")}\n\n…[truncated at the view word cap]`, truncated: true };
}

/**
 * An observed claim must cite something. Anything else is the model's own
 * conclusion, so it is recorded as one.
 */
export function enforceProvenance(entries: EvidenceEntry[]): { entries: EvidenceEntry[]; downgraded: number } {
  let downgraded = 0;
  const out = entries.map((entry) => {
    if (entry.status !== "observed") return entry;
    if (entry.locations.length > 0 || entry.artifacts.length > 0) return entry;
    downgraded += 1;
    return { ...entry, status: "inferred" as const, confidence: "low" as const };
  });
  return { entries: out, downgraded };
}

/**
 * Parse + normalise one view response. Returns null when the response has no
 * usable content — the caller records a FAILED view rather than storing noise.
 */
export function parseViewResponse(raw: string, spec: ViewSpec, opts: { commit?: string | null } = {}): ParsedView | null {
  if (!raw || !raw.trim()) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(extractJsonBlock(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const rawContent = typeof obj.contentMd === "string" ? obj.contentMd.trim() : "";
  if (!rawContent) return null;

  const warnings: string[] = [];
  const { text: contentMd, truncated } = truncateToWords(rawContent, spec.maxWords);
  if (truncated) warnings.push(`content exceeded the ${spec.maxWords}-word cap and was truncated`);

  const words = countWords(contentMd);
  if (words < spec.minWords) warnings.push(`content is ${words} words, below the ${spec.minWords}-word floor`);

  // A view that skipped its required sections is thin grounding — record it, but
  // still store: a partial view beats no view, and the warning is visible.
  const missing = spec.sections.filter((section) => !contentMd.toLowerCase().includes(section.toLowerCase()));
  if (missing.length > 0) warnings.push(`missing sections: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);

  const { entries, downgraded } = enforceProvenance(projectEvidence(obj.evidence));
  if (downgraded > 0) warnings.push(`${downgraded} evidence entr${downgraded === 1 ? "y" : "ies"} claimed "observed" without a source and were downgraded to inferred`);

  const commit = opts.commit ?? null;
  const evidence = commit ? entries.map((e) => ({ ...e, commit: e.commit ?? commit })) : entries;

  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim().slice(0, 200) : spec.title;
  const structured =
    obj.structured && typeof obj.structured === "object" && !Array.isArray(obj.structured)
      ? (obj.structured as Record<string, unknown>)
      : null;

  return {
    title,
    contentMd,
    structured,
    evidence,
    tokenEstimate: estimateTokens(contentMd),
    contentHash: sha256(contentMd),
    warnings,
  };
}
