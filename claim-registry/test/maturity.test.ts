/**
 * Unit tests for the claim-registry maturity gates (M-CR1/§4). DB-free.
 */
import { describe, it, expect } from 'vitest';
import { evaluateTransition, autoTransitionFor, hasTierAtLeast, type TransitionContext } from '../src/lib/maturity';

const NOW = 1_000_000 * 86_400_000;
const ctx = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  posteriorProb: 0.85, effectiveEvidence: 3.5, presentTiers: ['T2', 'T1'], approvedBy: null, thresholdHeldSinceMs: null, nowMs: NOW, ...over,
});

describe('hasTierAtLeast', () => {
  it('respects tier strength order (T0 strongest)', () => {
    expect(hasTierAtLeast(['T3'], 'T2')).toBe(false);
    expect(hasTierAtLeast(['T2'], 'T2')).toBe(true);
    expect(hasTierAtLeast(['T0'], 'T2')).toBe(true);
  });
});

describe('evaluateTransition', () => {
  it('rejects state skipping', () => {
    expect(evaluateTransition('FRAGMENT', 'VALIDATED', ctx()).allowed).toBe(false);
    expect(evaluateTransition('HYPOTHESIS', 'SPEC_BOUND', ctx()).allowed).toBe(false);
  });

  it('HYPOTHESIS→VALIDATED auto-passes on posterior + evidence + tier', () => {
    expect(evaluateTransition('HYPOTHESIS', 'VALIDATED', ctx()).allowed).toBe(true);
  });
  it('HYPOTHESIS→VALIDATED fails with the first unmet predicate', () => {
    expect(evaluateTransition('HYPOTHESIS', 'VALIDATED', ctx({ posteriorProb: 0.7 })).reason).toMatch(/posterior/);
    expect(evaluateTransition('HYPOTHESIS', 'VALIDATED', ctx({ effectiveEvidence: 1 })).reason).toMatch(/effectiveEvidence/);
    expect(evaluateTransition('HYPOTHESIS', 'VALIDATED', ctx({ presentTiers: ['T3'] })).reason).toMatch(/tier/);
  });

  it('VALIDATED→REQUIREMENT needs 0.9 + human approval', () => {
    expect(evaluateTransition('VALIDATED', 'REQUIREMENT', ctx({ posteriorProb: 0.95, effectiveEvidence: 5 })).reason).toMatch(/approval/);
    expect(evaluateTransition('VALIDATED', 'REQUIREMENT', ctx({ posteriorProb: 0.95, effectiveEvidence: 5, approvedBy: 'u1' })).allowed).toBe(true);
  });

  it('REQUIREMENT→SPEC_BOUND requires the posterior to have held ≥14d', () => {
    const held13 = ctx({ posteriorProb: 0.95, approvedBy: 'u1', thresholdHeldSinceMs: NOW - 13 * 86_400_000 });
    const held15 = ctx({ posteriorProb: 0.95, approvedBy: 'u1', thresholdHeldSinceMs: NOW - 15 * 86_400_000 });
    expect(evaluateTransition('REQUIREMENT', 'SPEC_BOUND', held13).reason).toMatch(/hold/);
    expect(evaluateTransition('REQUIREMENT', 'SPEC_BOUND', held15).allowed).toBe(true);
  });

  it('falsification is reachable from any state at ≤0.20, and needs the floor', () => {
    for (const s of ['FRAGMENT', 'HYPOTHESIS', 'VALIDATED', 'REQUIREMENT', 'SPEC_BOUND'] as const) {
      expect(evaluateTransition(s, 'FALSIFIED', ctx({ posteriorProb: 0.15 })).allowed).toBe(true);
    }
    expect(evaluateTransition('VALIDATED', 'FALSIFIED', ctx({ posteriorProb: 0.5 })).allowed).toBe(false);
  });
});

describe('autoTransitionFor', () => {
  it('auto-VALIDATES a qualifying HYPOTHESIS and auto-FALSIFIES anything at the floor', () => {
    expect(autoTransitionFor('HYPOTHESIS', ctx())).toBe('VALIDATED');
    expect(autoTransitionFor('HYPOTHESIS', ctx({ posteriorProb: 0.6 }))).toBeNull(); // below 0.8
    expect(autoTransitionFor('VALIDATED', ctx({ posteriorProb: 0.1 }))).toBe('FALSIFIED');
    expect(autoTransitionFor('VALIDATED', ctx())).toBeNull(); // VALIDATED→REQUIREMENT needs human, not auto
  });
});
