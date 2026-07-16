/**
 * Pure, framework-free logic shared by Synthesis screens. Kept free of React /
 * Next imports so it can be unit-tested directly with ts-node.
 */

import type { SynClaim, SynProject } from "./types";

/* ─── Consistency thresholds (Logic Console) ────────────────────────────── */

/** Estimator variance above this flags a claim as "contested". */
export const CONTESTED_VAR = 0.05;
/** Posterior mean below this flags a claim as "likely false but still in play". */
export const LIKELY_FALSE = 0.35;

export function isContested(claim: SynClaim): boolean {
  return (claim.disagreement ?? 0) > CONTESTED_VAR;
}
export function isLikelyFalse(claim: SynClaim): boolean {
  return (claim.mean ?? 0.5) < LIKELY_FALSE;
}
export function isUnbacked(claim: SynClaim): boolean {
  return (claim.estimateCount ?? 0) <= 1;
}

/* ─── Use-case maturity heuristic (Use-Case Registry) ───────────────────── */

export type Maturity = "SEED" | "SHAPING" | "DELIVERING" | "MATURE";

export const MATURITY_ORDER: Maturity[] = ["MATURE", "DELIVERING", "SHAPING", "SEED"];

/**
 * Maturity from portfolio signals we already have: activity (status) + delivery
 * (work-item count). Returns a score in [0,1] and its bucket label. Both are
 * surfaced in the UI for transparency.
 */
export function computeMaturity(p: Pick<SynProject, "status" | "workItemCount">): {
  score: number;
  label: Maturity;
} {
  const items = p.workItemCount ?? 0;
  const activity = p.status === "ACTIVE" ? 0.35 : p.status === "ARCHIVED" ? 0.1 : 0.2;
  const delivery = Math.min(0.65, items * 0.13);
  const score = Math.min(1, activity + delivery);
  const label: Maturity =
    score >= 0.8 ? "MATURE" : score >= 0.55 ? "DELIVERING" : score >= 0.3 ? "SHAPING" : "SEED";
  return { score, label };
}

/* ─── Relative time (System Overview) ───────────────────────────────────── */

export function timeAgo(iso?: string, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = now - then;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
