import { describe, it, expect } from 'vitest';
import {
  dedupeKeyFor, detectStarvation, contradictionLive, contradictionSeverity,
  DEFAULT_STARVATION,
} from '../src/lib/ambiguity';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

describe('dedupeKeyFor', () => {
  it('is order-independent over the involved claims', () => {
    expect(dedupeKeyFor('CONTRADICTION', ['b', 'a'])).toBe(dedupeKeyFor('CONTRADICTION', ['a', 'b']));
  });
  it('deduplicates repeated ids', () => {
    expect(dedupeKeyFor('STARVATION', ['a', 'a'])).toBe('STARVATION:a');
  });
  it('separates by type', () => {
    expect(dedupeKeyFor('CONTRADICTION', ['a'])).not.toBe(dedupeKeyFor('MISSING_EVIDENCE', ['a']));
  });
});

describe('detectStarvation', () => {
  const young = (createdAtMs: number, evidenceCount: number) => ({ maturity: 'HYPOTHESIS', createdAtMs, evidenceCount, lastEvidenceAtMs: null });

  it('flags a young, evidence-less claim that aged past the window', () => {
    const r = detectStarvation(young(NOW - 40 * DAY, 0), NOW);
    expect(r.starved).toBe(true);
    expect(r.reason).toMatch(/no evidence/);
  });
  it('does not flag a claim that has evidence', () => {
    expect(detectStarvation(young(NOW - 40 * DAY, 2), NOW).starved).toBe(false);
  });
  it('does not flag a claim younger than the window', () => {
    expect(detectStarvation(young(NOW - 10 * DAY, 0), NOW).starved).toBe(false);
  });
  it('never starves a matured claim (it decays instead)', () => {
    const r = detectStarvation({ maturity: 'VALIDATED', createdAtMs: NOW - 400 * DAY, evidenceCount: 0, lastEvidenceAtMs: null }, NOW);
    expect(r.starved).toBe(false);
  });
  it('honors a custom policy window', () => {
    expect(detectStarvation(young(NOW - 40 * DAY, 0), NOW, { starveDays: 60 }).starved).toBe(false);
    expect(DEFAULT_STARVATION.starveDays).toBe(30);
  });
});

describe('contradictionLive', () => {
  const believed = { status: 'ACTIVE', posteriorProb: 0.9 };
  it('is live when both sides are ACTIVE and believed', () => {
    expect(contradictionLive(believed, { status: 'ACTIVE', posteriorProb: 0.8 })).toBe(true);
  });
  it('is resolved once one side falls below the belief floor', () => {
    expect(contradictionLive(believed, { status: 'ACTIVE', posteriorProb: 0.4 })).toBe(false);
  });
  it('is resolved once one side is no longer ACTIVE', () => {
    expect(contradictionLive(believed, { status: 'FALSIFIED', posteriorProb: 0.9 })).toBe(false);
  });
});

describe('contradictionSeverity', () => {
  it('scales with the weaker side of the tension', () => {
    expect(contradictionSeverity({ status: 'ACTIVE', posteriorProb: 0.95 }, { status: 'ACTIVE', posteriorProb: 0.9 })).toBe('HIGH');
    expect(contradictionSeverity({ status: 'ACTIVE', posteriorProb: 0.95 }, { status: 'ACTIVE', posteriorProb: 0.7 })).toBe('MEDIUM');
    expect(contradictionSeverity({ status: 'ACTIVE', posteriorProb: 0.95 }, { status: 'ACTIVE', posteriorProb: 0.55 })).toBe('LOW');
  });
});
