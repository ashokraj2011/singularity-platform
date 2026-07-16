/**
 * Unit tests for the claim-registry posterior engine (M-CR1) — DB-free, clock-free.
 * This is the load-bearing correctness surface: tier caps, decay, same-source
 * diminishing, and the log-odds → probability roll-up.
 */
import { describe, it, expect } from 'vitest';
import {
  computePosterior, capLLR, sigmoid, logit, priorLogOddsForKind, isFalsified,
  DEFAULT_TIER_LLR_CAP, type PosteriorEvidenceLink,
} from '../src/lib/posterior';

const NOW = 1_000_000 * 86_400_000; // a fixed "today" in epoch ms
const daysAgo = (d: number) => NOW - d * 86_400_000;
const link = (over: Partial<PosteriorEvidenceLink> = {}): PosteriorEvidenceLink => ({
  direction: 'SUPPORTS', tier: 'T2', logLikelihoodRatio: 1.1, sourceKey: 's1', decayExempt: false, observedAtMs: NOW, ...over,
});

describe('sigmoid / logit', () => {
  it('round-trips and is centered at 0.5', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 9);
    expect(sigmoid(logit(0.8))).toBeCloseTo(0.8, 9);
    expect(sigmoid(logit(0.2))).toBeCloseTo(0.2, 9);
  });
  it('is numerically stable at extremes', () => {
    expect(sigmoid(1000)).toBeCloseTo(1, 9);
    expect(sigmoid(-1000)).toBeCloseTo(0, 9);
  });
});

describe('capLLR', () => {
  it('clamps magnitude to the tier cap, preserving sign', () => {
    expect(capLLR(99, 'T0')).toBe(4.6);
    expect(capLLR(99, 'T3')).toBe(0.4);
    expect(capLLR(-99, 'T1')).toBe(-2.3);
    expect(capLLR(0.5, 'T0')).toBe(0.5); // under the cap, untouched
  });
});

describe('priorLogOddsForKind', () => {
  it('maps kind priors to log-odds', () => {
    expect(priorLogOddsForKind('HYPOTHESIS')).toBeCloseTo(0, 9); // 0.5
    expect(sigmoid(priorLogOddsForKind('CONSTRAINT'))).toBeCloseTo(0.95, 9);
    expect(sigmoid(priorLogOddsForKind('unknown'))).toBeCloseTo(0.5, 9);
  });
});

describe('computePosterior', () => {
  it('SUPPORTS raises, CONTRADICTS lowers', () => {
    const up = computePosterior(0, [link({ direction: 'SUPPORTS' })], NOW, 180);
    const down = computePosterior(0, [link({ direction: 'CONTRADICTS' })], NOW, 180);
    expect(up.posteriorProb).toBeGreaterThan(0.5);
    expect(down.posteriorProb).toBeLessThan(0.5);
  });

  it('caps a huge raw LLR at the tier ceiling', () => {
    const capped = computePosterior(0, [link({ tier: 'T2', logLikelihoodRatio: 999 })], NOW, 180);
    expect(capped.posteriorLogOdds).toBeCloseTo(DEFAULT_TIER_LLR_CAP.T2, 9); // 1.1, not 999
  });

  it('decays old evidence — fresh moves the posterior more than stale', () => {
    const fresh = computePosterior(0, [link({ observedAtMs: NOW })], NOW, 180);
    const stale = computePosterior(0, [link({ observedAtMs: daysAgo(180) })], NOW, 180);
    expect(stale.posteriorLogOdds).toBeCloseTo(fresh.posteriorLogOdds * 0.5, 6); // one half-life = ×0.5
    expect(stale.posteriorLogOdds).toBeLessThan(fresh.posteriorLogOdds);
  });

  it('decayExempt evidence keeps full weight regardless of age', () => {
    const exempt = computePosterior(0, [link({ observedAtMs: daysAgo(3650), decayExempt: true })], NOW, 180);
    expect(exempt.posteriorLogOdds).toBeCloseTo(DEFAULT_TIER_LLR_CAP.T2, 9);
  });

  it('diminishes same-source evidence: the 2nd link from a source counts half', () => {
    const two = computePosterior(0, [
      link({ sourceKey: 'interview-42', observedAtMs: daysAgo(1) }),
      link({ sourceKey: 'interview-42', observedAtMs: NOW }),
    ], NOW, 180);
    // 1st (older): 1.1 · decay(1d); 2nd: 1.1/2 · decay(0). Both < two independent 1.1s.
    const twoIndependent = computePosterior(0, [
      link({ sourceKey: 'a', observedAtMs: NOW }), link({ sourceKey: 'b', observedAtMs: NOW }),
    ], NOW, 180);
    expect(two.posteriorLogOdds).toBeLessThan(twoIndependent.posteriorLogOdds);
    expect(two.posteriorLogOdds).toBeLessThan(1.1 * 1.6); // well under 2×1.1
  });

  it('effectiveEvidence accumulates magnitude regardless of direction', () => {
    const mixed = computePosterior(0, [
      link({ direction: 'SUPPORTS', sourceKey: 'a' }),
      link({ direction: 'CONTRADICTS', sourceKey: 'b' }),
    ], NOW, 180);
    expect(mixed.posteriorProb).toBeCloseTo(0.5, 6);          // support ≈ contradiction → net ~0
    expect(mixed.effectiveEvidence).toBeCloseTo(2.2, 6);       // but we know 2.2 worth of things
  });

  it('M-CR1 smoke (pure): prior 0.5 + T2 + T1 support → posterior ≥ 0.8 and effEvidence ≥ 3.0', () => {
    const r = computePosterior(priorLogOddsForKind('HYPOTHESIS'), [
      link({ tier: 'T2', logLikelihoodRatio: 1.1, sourceKey: 'spike-1', direction: 'SUPPORTS' }),
      link({ tier: 'T1', logLikelihoodRatio: 2.3, sourceKey: 'experiment-1', direction: 'SUPPORTS' }),
    ], NOW, 180);
    expect(r.posteriorProb).toBeGreaterThanOrEqual(0.8);       // crosses the VALIDATED gate
    expect(r.effectiveEvidence).toBeGreaterThanOrEqual(3.0);   // and the evidence-mass gate
  });
});

describe('isFalsified', () => {
  it('fires at/below the 0.20 floor', () => {
    expect(isFalsified(0.2)).toBe(true);
    expect(isFalsified(0.19)).toBe(true);
    expect(isFalsified(0.21)).toBe(false);
  });
});
