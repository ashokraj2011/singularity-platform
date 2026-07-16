/**
 * claim-registry — the posterior engine (M-CR1). PURE: no I/O, no DB, no clock
 * (now is passed in), so the belief math unit-tests without the stack. This module
 * is the load-bearing correctness core of the whole service.
 *
 * Model (spec §3): log-odds accumulation with tier-capped likelihood ratios and
 * exponential decay.
 *
 *   posterior_log_odds(t) = prior_log_odds
 *                         + Σ_links  sign(direction) · LLR_effective · exp(−λ · age_days)
 *   λ = ln(2) / halfLifeDays        age_days = (t − observedAt) / 1 day
 *   posterior_prob = σ(posterior_log_odds)
 *
 * - LLR magnitude is capped per evidence tier (T0 strongest … T3 weakest).
 * - Same-source diminishing: the n-th link sharing a sourceKey contributes
 *   LLR / (1 + n_prior_from_source) — five quotes from one interview are not five
 *   interviews. The dedup guard against posterior inflation.
 * - decayExempt links (regulatory/contractual facts) contribute at full weight
 *   regardless of age.
 * - effectiveEvidence = Σ decay-weighted |LLR| — the direction-independent "how
 *   much do we actually know" mass used in maturity gating.
 */

export type EvidenceTier = 'T0' | 'T1' | 'T2' | 'T3';
export type EvidenceDirection = 'SUPPORTS' | 'CONTRADICTS';

/**
 * Tier LLR caps (spec §3). Deterministic evidence can move the belief far; soft
 * anecdote barely at all. Overridable via config/tier-policy.json (hot-reloadable)
 * — pass a custom map to computePosterior for the policy in force.
 */
export const DEFAULT_TIER_LLR_CAP: Record<EvidenceTier, number> = {
  T0: 4.6, // ~99:1  — deterministic, reproducible
  T1: 2.3, // ~10:1  — controlled experiment
  T2: 1.1, // ~3:1   — structured qualitative
  T3: 0.4, // ~1.5:1 — soft / anecdotal
};

/** Default prior probability by claim kind (spec §3). */
export const KIND_PRIOR_PROB: Record<string, number> = {
  HYPOTHESIS: 0.5,
  ASSUMPTION: 0.65, // held-true bias — which is exactly why they decay fastest
  OBSERVATION: 0.8,
  CONSTRAINT: 0.95, // decayExempt evidence expected
  DECISION: 0.6,
  REQUIREMENT: 0.7,
};

const DAY_MS = 86_400_000;
const LN2 = Math.LN2;

export function sigmoid(logOdds: number): number {
  // Numerically stable logistic.
  if (logOdds >= 0) {
    const z = Math.exp(-logOdds);
    return 1 / (1 + z);
  }
  const z = Math.exp(logOdds);
  return z / (1 + z);
}

export function logit(prob: number): number {
  const p = Math.min(1 - 1e-9, Math.max(1e-9, prob));
  return Math.log(p / (1 - p));
}

export function priorLogOddsForKind(kind: string): number {
  return logit(KIND_PRIOR_PROB[kind] ?? 0.5);
}

/** Clamp a raw LLR magnitude to the tier cap, preserving sign. */
export function capLLR(rawLLR: number, tier: EvidenceTier, caps: Record<EvidenceTier, number> = DEFAULT_TIER_LLR_CAP): number {
  const cap = caps[tier];
  const sign = rawLLR < 0 ? -1 : 1;
  return sign * Math.min(Math.abs(rawLLR), cap);
}

export interface PosteriorEvidenceLink {
  direction: EvidenceDirection;
  tier: EvidenceTier;
  /** raw signed/unsigned LLR magnitude; capped by tier here */
  logLikelihoodRatio: number;
  /** dedup key: links sharing this are diminished */
  sourceKey: string;
  decayExempt: boolean;
  /** epoch ms — when the evidence was true in the world */
  observedAtMs: number;
}

export interface PosteriorResult {
  posteriorLogOdds: number;
  posteriorProb: number;
  effectiveEvidence: number;
}

/**
 * Recompute a claim's posterior from its prior + evidence links, as of `nowMs`.
 * Pure — the caller supplies the current time, so results are deterministic and testable.
 */
export function computePosterior(
  priorLogOdds: number,
  links: PosteriorEvidenceLink[],
  nowMs: number,
  halfLifeDays: number,
  caps: Record<EvidenceTier, number> = DEFAULT_TIER_LLR_CAP,
): PosteriorResult {
  const lambda = LN2 / Math.max(1, halfLifeDays);

  // Same-source diminishing: within each sourceKey, the k-th link (chronological
  // by observedAt) contributes 1/(1+k). Sort so the ordering is deterministic.
  const bySource = new Map<string, PosteriorEvidenceLink[]>();
  for (const link of links) {
    const arr = bySource.get(link.sourceKey);
    if (arr) arr.push(link);
    else bySource.set(link.sourceKey, [link]);
  }
  for (const arr of bySource.values()) arr.sort((a, b) => a.observedAtMs - b.observedAtMs);

  let accum = priorLogOdds;
  let effectiveEvidence = 0;

  for (const arr of bySource.values()) {
    arr.forEach((link, k) => {
      const capped = Math.abs(capLLR(link.logLikelihoodRatio, link.tier, caps));
      const diminished = capped / (1 + k);
      const ageDays = Math.max(0, (nowMs - link.observedAtMs) / DAY_MS);
      const decay = link.decayExempt ? 1 : Math.exp(-lambda * ageDays);
      const weighted = diminished * decay;
      const sign = link.direction === 'SUPPORTS' ? 1 : -1;
      accum += sign * weighted;
      effectiveEvidence += weighted; // direction-independent mass
    });
  }

  return { posteriorLogOdds: accum, posteriorProb: sigmoid(accum), effectiveEvidence };
}

/** Maturity falsification floor + validation ceiling helpers (spec §4). */
export const FALSIFICATION_FLOOR = 0.2;
export function isFalsified(posteriorProb: number): boolean {
  return posteriorProb <= FALSIFICATION_FLOOR;
}
