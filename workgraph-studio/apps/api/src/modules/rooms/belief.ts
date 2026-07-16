/**
 * The Bayesian belief engine — the load-bearing math of the epistemic layer. PURE: no I/O, no clock,
 * no DB (age/now are passed in), so it is fully unit-testable without the stack.
 *
 * Model: every Claim carries a Beta(alpha, beta) posterior over P(claim is true). Participant
 * probability estimates POOL (calibration-weighted) into a prior; their VARIANCE is the ignorance
 * signal (where mental models diverge). Evidence updates the posterior with pseudo-counts CAPPED by
 * source tier (production reality moves it far, an agent simulation barely) and applied idempotently
 * by evidence identity. Confidence DECAYS on read as a pure function of evidence age + claim type.
 */

export type EvidenceTier = "PRODUCTION" | "EXPERIMENT" | "SOURCE_DOCUMENT" | "SIMULATION" | "AGENT" | "OPINION";
export type ClaimTypeKey = "MARKET" | "USER" | "OPERATIONAL" | "TECHNICAL";

export interface Beta {
  alpha: number;
  beta: number;
}
export interface WeightedEstimate {
  probability: number; // 0..1, P(claim true)
  weight?: number; // estimator calibration weight (default 1)
}
export interface EvidenceInput {
  id: string; // evidence identity — dedupe key for idempotent promotion
  supports: boolean; // does the evidence support (true) or refute (false) the claim?
  tier: EvidenceTier;
  weight?: number; // requested pseudo-count; capped by the tier cap below
}

/** Pseudo-count cap by source tier — cheap synthetic evidence can suggest but never swamp reality.
 *  OPINION is 0: opinions stay local and only evidence travels (paper's promotion rule). */
export const TIER_CAP: Record<EvidenceTier, number> = {
  PRODUCTION: 20,
  EXPERIMENT: 10,
  SOURCE_DOCUMENT: 6, // a document asserting X is weak evidence X is true — below executed-test, above simulation
  SIMULATION: 4,
  AGENT: 2,
  OPINION: 0,
};

/** Half-life (days) for decay-on-read — market beliefs erode in months, technical constraints in years. */
export const CLAIM_HALF_LIFE_DAYS: Record<ClaimTypeKey, number> = {
  MARKET: 90,
  USER: 120,
  OPERATIONAL: 180,
  TECHNICAL: 730,
};

/** Uniform Laplace prior — the state of maximal ignorance a decayed claim relaxes back toward. */
export const UNIFORM_PRIOR: Beta = { alpha: 1, beta: 1 };
/** Default concentration a pooled opinion is worth — weak, so real evidence dominates over time. */
export const BASE_PRIOR_STRENGTH = 2;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export interface PooledBelief {
  mean: number;
  variance: number; // disagreement across estimators — the ignorance signal
  n: number;
}

/** Linear opinion pool: calibration-weighted mean of probabilities + weighted variance (disagreement). */
export function poolEstimates(estimates: WeightedEstimate[]): PooledBelief {
  const valid = estimates.filter((e) => Number.isFinite(e.probability));
  if (!valid.length) return { mean: 0.5, variance: 0, n: 0 };
  let wsum = 0;
  let msum = 0;
  for (const e of valid) {
    const w = Math.max(e.weight ?? 1, 0);
    wsum += w;
    msum += w * clamp01(e.probability);
  }
  const mean = wsum > 0 ? msum / wsum : 0.5;
  let vsum = 0;
  for (const e of valid) {
    const w = Math.max(e.weight ?? 1, 0);
    const d = clamp01(e.probability) - mean;
    vsum += w * d * d;
  }
  const variance = wsum > 0 ? vsum / wsum : 0;
  return { mean, variance, n: valid.length };
}

/** Turn a pooled mean into a regularized Beta prior (starts from uniform, so opinions never assert certainty). */
export function toBetaPrior(mean: number, strength: number = BASE_PRIOR_STRENGTH): Beta {
  const m = clamp01(mean);
  const s = Math.max(strength, 0);
  return { alpha: UNIFORM_PRIOR.alpha + m * s, beta: UNIFORM_PRIOR.beta + (1 - m) * s };
}

export interface BetaStats {
  mean: number;
  variance: number;
  concentration: number; // alpha + beta — how much the posterior "knows"
}
export function betaStats(b: Beta): BetaStats {
  const a = Math.max(b.alpha, 1e-9);
  const bb = Math.max(b.beta, 1e-9);
  const c = a + bb;
  return { mean: a / c, variance: (a * bb) / (c * c * (c + 1)), concentration: c };
}

/** Apply one piece of evidence, capping the pseudo-count by the source tier. */
export function applyEvidence(prior: Beta, ev: EvidenceInput): Beta {
  const cap = TIER_CAP[ev.tier] ?? 0;
  const pseudo = Math.max(0, Math.min(ev.weight ?? cap, cap));
  if (pseudo === 0) return { ...prior };
  return ev.supports
    ? { alpha: prior.alpha + pseudo, beta: prior.beta }
    : { alpha: prior.alpha, beta: prior.beta + pseudo };
}

/** Fold a list of evidence into a posterior, idempotent by evidence identity (same id counts once). */
export function foldEvidence(prior: Beta, evidence: EvidenceInput[]): Beta {
  const seen = new Set<string>();
  let b: Beta = { ...prior };
  for (const ev of evidence) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    b = applyEvidence(b, ev);
  }
  return b;
}

/** Decay a posterior toward the uniform prior as its evidence ages — a pure function of age + claim type. */
export function decayOnRead(b: Beta, ageDays: number, claimType: ClaimTypeKey = "TECHNICAL", basePrior: Beta = UNIFORM_PRIOR): Beta {
  const halfLife = CLAIM_HALF_LIFE_DAYS[claimType] ?? 180;
  const f = Math.pow(0.5, Math.max(0, ageDays) / halfLife);
  return {
    alpha: basePrior.alpha + (b.alpha - basePrior.alpha) * f,
    beta: basePrior.beta + (b.beta - basePrior.beta) * f,
  };
}

export interface Rankable {
  disagreement: number; // pooled estimate variance
  posteriorVariance?: number;
}
/** Rank by where the team is most ignorant: highest estimator disagreement first (posterior variance breaks ties). */
export function ignoranceRank<T extends Rankable>(items: T[]): T[] {
  return [...items].sort(
    (x, y) => y.disagreement - x.disagreement || (y.posteriorVariance ?? 0) - (x.posteriorVariance ?? 0),
  );
}

/** Expected information gain from a probe at a given tier: expected reduction in posterior variance.
 *  The probe supports with probability = current mean, refutes otherwise. Seeds the Phase-2 stopping rule. */
export function expectedInfoGain(prior: Beta, tier: EvidenceTier): number {
  const { mean, variance } = betaStats(prior);
  const onSupport = betaStats(applyEvidence(prior, { id: "_eig", supports: true, tier }));
  const onRefute = betaStats(applyEvidence(prior, { id: "_eig", supports: false, tier }));
  const expectedPosteriorVariance = mean * onSupport.variance + (1 - mean) * onRefute.variance;
  return Math.max(0, variance - expectedPosteriorVariance);
}

/** The stopping rule: exploration ends when the best remaining probe's gain per hour falls below the bar. */
export function converged(bestGainPerHour: number, barPerHour: number): boolean {
  return bestGainPerHour < barPerHour;
}
