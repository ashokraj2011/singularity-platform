/**
 * claim-registry — the maturity state machine + gate policy (M-CR1/§4). PURE:
 * gate evaluation is a function of the claim's belief state + policy, so it
 * unit-tests without the DB.
 *
 *   FRAGMENT → HYPOTHESIS → VALIDATED → REQUIREMENT → SPEC_BOUND
 *        └──────────┴────────────┴────────── FALSIFIED (any state, prob ≤ 0.20)
 *
 * Falsification is reachable from any state and is automatic + terminal. Every
 * other transition is gated (posterior / effectiveEvidence / min tier / human
 * approval); gates are per-capability overridable — pass the policy in.
 */
import { FALSIFICATION_FLOOR, type EvidenceTier } from './posterior';

export type MaturityState = 'FRAGMENT' | 'HYPOTHESIS' | 'VALIDATED' | 'REQUIREMENT' | 'SPEC_BOUND' | 'FALSIFIED';

// Tier strength order (T0 strongest). "min tier T2 present" ⇒ at least one link at T2 or stronger.
const TIER_RANK: Record<EvidenceTier, number> = { T0: 3, T1: 2, T2: 1, T3: 0 };
export function hasTierAtLeast(present: EvidenceTier[], min: EvidenceTier): boolean {
  return present.some((t) => TIER_RANK[t] >= TIER_RANK[min]);
}

export interface GateRule {
  posteriorMin?: number;
  effectiveEvidenceMin?: number;
  minTier?: EvidenceTier;
  humanApproval: boolean;
  /** REQUIREMENT → SPEC_BOUND: posterior must have held above threshold this long */
  heldDays?: number;
}

// Default gate policy (spec §4). Keyed "FROM->TO".
export const DEFAULT_GATES: Record<string, GateRule> = {
  'FRAGMENT->HYPOTHESIS': { humanApproval: true }, // curator accept (lowering review)
  'HYPOTHESIS->VALIDATED': { posteriorMin: 0.8, effectiveEvidenceMin: 3.0, minTier: 'T2', humanApproval: false },
  'VALIDATED->REQUIREMENT': { posteriorMin: 0.9, effectiveEvidenceMin: 4.0, minTier: 'T1', humanApproval: true },
  'REQUIREMENT->SPEC_BOUND': { posteriorMin: 0.9, humanApproval: true, heldDays: 14 },
};

const LEGAL_EDGES = new Set(Object.keys(DEFAULT_GATES));

export interface TransitionContext {
  posteriorProb: number;
  effectiveEvidence: number;
  presentTiers: EvidenceTier[];
  approvedBy?: string | null;
  /** epoch ms the posterior first crossed the target threshold (for heldDays) */
  thresholdHeldSinceMs?: number | null;
  nowMs: number;
}

export interface TransitionResult {
  allowed: boolean;
  /** the first failing predicate, for a 422 body */
  reason?: string;
}

/**
 * Evaluate whether `from → to` is allowed given the claim's belief state.
 * Falsification (prob ≤ 0.20) is automatic from any state and needs no gate.
 */
export function evaluateTransition(
  from: MaturityState,
  to: MaturityState,
  ctx: TransitionContext,
  gates: Record<string, GateRule> = DEFAULT_GATES,
): TransitionResult {
  if (to === 'FALSIFIED') {
    return ctx.posteriorProb <= FALSIFICATION_FLOOR
      ? { allowed: true }
      : { allowed: false, reason: `falsification requires posterior ≤ ${FALSIFICATION_FLOOR} (is ${ctx.posteriorProb.toFixed(3)})` };
  }
  const key = `${from}->${to}`;
  if (!LEGAL_EDGES.has(key)) return { allowed: false, reason: `illegal transition ${key} (no state skipping)` };

  const gate = gates[key];
  if (!gate) return { allowed: false, reason: `no gate policy for ${key}` };

  if (gate.posteriorMin !== undefined && ctx.posteriorProb < gate.posteriorMin) {
    return { allowed: false, reason: `posterior ${ctx.posteriorProb.toFixed(3)} < ${gate.posteriorMin}` };
  }
  if (gate.effectiveEvidenceMin !== undefined && ctx.effectiveEvidence < gate.effectiveEvidenceMin) {
    return { allowed: false, reason: `effectiveEvidence ${ctx.effectiveEvidence.toFixed(2)} < ${gate.effectiveEvidenceMin}` };
  }
  if (gate.minTier !== undefined && !hasTierAtLeast(ctx.presentTiers, gate.minTier)) {
    return { allowed: false, reason: `no evidence at tier ${gate.minTier} or stronger` };
  }
  if (gate.humanApproval && !ctx.approvedBy) {
    return { allowed: false, reason: `human approval required` };
  }
  if (gate.heldDays !== undefined) {
    const held = ctx.thresholdHeldSinceMs ? (ctx.nowMs - ctx.thresholdHeldSinceMs) / 86_400_000 : 0;
    if (held < gate.heldDays) return { allowed: false, reason: `posterior must hold ≥ ${gate.heldDays}d (held ${held.toFixed(1)}d)` };
  }
  return { allowed: true };
}

// The posterior threshold a claim must stay above to keep its earned maturity.
export const MATURITY_THRESHOLD: Record<string, number> = {
  VALIDATED: 0.8,
  REQUIREMENT: 0.9,
  SPEC_BOUND: 0.9,
};

/**
 * Did decay just drop the posterior below the claim's maturity threshold? Returns the
 * crossed threshold (for the event), or null. A VALIDATED+ claim is NOT auto-demoted
 * (spec §4) — it emits claim.decay.threshold_crossed and a human decides; only
 * falsification (≤0.20) is automatic.
 */
export function decayThresholdCrossed(maturity: MaturityState, prevProb: number, newProb: number): number | null {
  const th = MATURITY_THRESHOLD[maturity];
  if (th === undefined) return null;
  return prevProb >= th && newProb < th ? th : null;
}

/** The one auto transition the recompute path applies without human action. */
export function autoTransitionFor(from: MaturityState, ctx: TransitionContext, gates?: Record<string, GateRule>): MaturityState | null {
  if (ctx.posteriorProb <= FALSIFICATION_FLOOR && from !== 'FALSIFIED') return 'FALSIFIED';
  if (from === 'HYPOTHESIS' && evaluateTransition('HYPOTHESIS', 'VALIDATED', ctx, gates).allowed) return 'VALIDATED';
  return null;
}
