/**
 * claim-registry — ambiguity detectors (M-CR4). PURE: an ambiguity is a function of
 * the claim's belief state + policy, so the sweep logic unit-tests without the DB.
 *
 * An ambiguity is a surfaced-but-unresolved epistemic tension the humans must decide:
 *   CONTRADICTION    — two still-believed claims asserted to contradict each other
 *   MISSING_EVIDENCE — a matured claim decayed below its gate threshold (from the decay sweep)
 *   STARVATION       — a young claim that has accumulated no evidence and is aging out
 *
 * The ledger NEVER auto-resolves or auto-demotes — it only surfaces. Humans decide.
 */
export type AmbiguityType = 'CONTRADICTION' | 'MISSING_EVIDENCE' | 'STARVATION';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * Deterministic, order-independent dedupe key over the claims an ambiguity involves.
 * Two OPEN ambiguities with the same key are the same logical tension (a sweep re-run
 * must not fork a duplicate) — the guard is code-enforced (see openAmbiguity), NOT a DB
 * unique, so a resolved row and a freshly-reopened one can coexist over time.
 */
export function dedupeKeyFor(type: AmbiguityType, claimIds: string[]): string {
  const ids = [...new Set(claimIds)].sort();
  return `${type}:${ids.join('|')}`;
}

// ── Starvation ────────────────────────────────────────────────────────────────
export interface StarvationInput {
  maturity: string;
  createdAtMs: number;
  evidenceCount: number;
  lastEvidenceAtMs: number | null;
}
export interface StarvationPolicy {
  /** an unmatured claim with zero evidence this old is starved */
  starveDays: number;
}
export const DEFAULT_STARVATION: StarvationPolicy = { starveDays: 30 };

export interface StarvationResult {
  starved: boolean;
  reason?: string;
  ageDays: number;
}

/**
 * A young claim (FRAGMENT / HYPOTHESIS) that has gathered no evidence and has aged past
 * the policy window is starved — it will never mature and clutters the belief set. A
 * VALIDATED+ claim has already earned its keep, so it can never starve (it decays instead).
 */
export function detectStarvation(input: StarvationInput, nowMs: number, policy: StarvationPolicy = DEFAULT_STARVATION): StarvationResult {
  const ageDays = (nowMs - input.createdAtMs) / 86_400_000;
  const young = input.maturity === 'FRAGMENT' || input.maturity === 'HYPOTHESIS';
  if (!young) return { starved: false, ageDays };
  if (input.evidenceCount === 0 && ageDays >= policy.starveDays) {
    return { starved: true, reason: `no evidence in ${ageDays.toFixed(0)}d (≥ ${policy.starveDays}d)`, ageDays };
  }
  return { starved: false, ageDays };
}

// ── Contradiction ───────────────────────────────────────────────────────────────
export interface ContradictionSide {
  status: string;
  posteriorProb: number;
}
/** A contradiction is only worth surfacing while BOTH sides are still believed. */
export const CONTRADICTION_BELIEF_FLOOR = 0.5;

export function contradictionLive(a: ContradictionSide, b: ContradictionSide, floor: number = CONTRADICTION_BELIEF_FLOOR): boolean {
  return a.status === 'ACTIVE' && b.status === 'ACTIVE' && a.posteriorProb >= floor && b.posteriorProb >= floor;
}

/** Sharper the tension (both sides strongly believed), higher the severity. */
export function contradictionSeverity(a: ContradictionSide, b: ContradictionSide): Severity {
  const min = Math.min(a.posteriorProb, b.posteriorProb);
  if (min >= 0.85) return 'HIGH';
  if (min >= 0.65) return 'MEDIUM';
  return 'LOW';
}

// Sort ranks used by the ledger read path (OPEN & HIGH-severity float to the top).
export const SEVERITY_RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
export const STATUS_RANK: Record<string, number> = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2, DISMISSED: 3 };
