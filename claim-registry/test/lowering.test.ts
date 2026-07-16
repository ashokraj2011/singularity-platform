/**
 * Unit tests for the lowering contract (M-CR2) — the pure parse/validate core.
 * DB-free, gateway-free: proves the model's proposed claims are turned into
 * well-formed candidates (or rejected), which is the load-bearing quality gate.
 */
import { describe, it, expect } from 'vitest';
import { parseLoweringResponse, extractJson, loweringSystemPrompt } from '../src/lib/lowering';

describe('extractJson', () => {
  it('pulls a JSON array out of a fenced reply', () => {
    expect(extractJson('sure:\n```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });
  it('pulls a bare array, and an object when there is no array', () => {
    expect(extractJson('prefix [1,2] suffix')).toEqual([1, 2]);
    expect(extractJson('here {"k":9} done')).toEqual({ k: 9 });
  });
  it('throws when there is no JSON', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('parseLoweringResponse', () => {
  const five = JSON.stringify([
    { statement: 'Feed latency is under 30s at p95', kind: 'ASSUMPTION', confidence: 0.7 },
    { statement: 'Month-end volume spikes 40x', kind: 'OBSERVATION', confidence: 0.8 },
    { statement: 'Vendor X cannot meet data residency', kind: 'CONSTRAINT', confidence: 0.9 },
    { statement: 'We will build in-house instead of buying', kind: 'DECISION', confidence: 0.6 },
    { statement: 'Users abandon onboarding at the KYC step', kind: 'HYPOTHESIS', confidence: 0.5 },
  ]);

  it('M-CR2 smoke (pure): a transcript pass yields >= 5 well-formed candidates', () => {
    const out = parseLoweringResponse(five);
    expect(out.length).toBeGreaterThanOrEqual(5);
    expect(out.every((c) => c.statement.length > 0 && c.confidence >= 0 && c.confidence <= 1)).toBe(true);
  });

  it('accepts an object with a candidates array', () => {
    const out = parseLoweringResponse(JSON.stringify({ candidates: [{ statement: 'X is true', kind: 'HYPOTHESIS' }] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe(0.5); // default
  });

  it('rejects a malformed candidate (bad kind / empty statement / out-of-range confidence)', () => {
    expect(() => parseLoweringResponse(JSON.stringify([{ statement: 'x', kind: 'WHATEVER' }]))).toThrow();
    expect(() => parseLoweringResponse(JSON.stringify([{ statement: '', kind: 'HYPOTHESIS' }]))).toThrow();
    expect(() => parseLoweringResponse(JSON.stringify([{ statement: 'x', kind: 'HYPOTHESIS', confidence: 2 }]))).toThrow();
  });

  it('yields an empty list for a capture with no claims', () => {
    expect(parseLoweringResponse('[]')).toEqual([]);
  });
});

describe('loweringSystemPrompt', () => {
  it('names the kinds and demands strict JSON', () => {
    const p = loweringSystemPrompt();
    expect(p).toMatch(/HYPOTHESIS/);
    expect(p).toMatch(/STRICT JSON/);
  });
});
