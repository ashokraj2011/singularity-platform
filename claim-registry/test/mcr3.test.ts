/**
 * Unit tests for the M-CR3 pure additions: the Beta→log-odds promotion translation
 * and decay threshold-crossing detection. DB-free.
 */
import { describe, it, expect } from 'vitest';
import { betaToLogOdds, sigmoid } from '../src/lib/posterior';
import { decayThresholdCrossed } from '../src/lib/maturity';

describe('betaToLogOdds (Rooms→registry promotion)', () => {
  it('maps the Beta mean to log-odds', () => {
    expect(betaToLogOdds(1, 1)).toBeCloseTo(0, 9); // 0.5
    expect(sigmoid(betaToLogOdds(9, 1))).toBeCloseTo(0.9, 9);
    expect(sigmoid(betaToLogOdds(1, 9))).toBeCloseTo(0.1, 9);
  });
  it('is finite at degenerate priors', () => {
    expect(Number.isFinite(betaToLogOdds(0, 5))).toBe(true);
    expect(Number.isFinite(betaToLogOdds(5, 0))).toBe(true);
  });
});

describe('decayThresholdCrossed', () => {
  it('fires exactly when the posterior drops through the maturity threshold', () => {
    expect(decayThresholdCrossed('VALIDATED', 0.85, 0.75)).toBe(0.8);   // crossed down
    expect(decayThresholdCrossed('REQUIREMENT', 0.95, 0.85)).toBe(0.9); // crossed down
  });
  it('does not fire when it stays above, or was already below', () => {
    expect(decayThresholdCrossed('VALIDATED', 0.85, 0.82)).toBeNull();  // still above
    expect(decayThresholdCrossed('VALIDATED', 0.75, 0.70)).toBeNull();  // already below
  });
  it('is null for states with no threshold', () => {
    expect(decayThresholdCrossed('FRAGMENT', 0.9, 0.1)).toBeNull();
    expect(decayThresholdCrossed('HYPOTHESIS', 0.9, 0.1)).toBeNull();
  });
});
