/**
 * M56 Slice B — Per-phase token + cost rollup.
 *
 * Verifies `computePhaseTokens` correctly buckets LlmCallRecord-shaped
 * entries by phase and sums input/output/cost/calls. The function is
 * pure (no audit store, no state side-effects) so tests run sub-ms.
 */
import { describe, expect, it } from "vitest";
import { computePhaseTokens } from "../src/mcp/invoke";
import type { LlmCallRecord } from "../src/audit/store";

type Rec = Pick<LlmCallRecord, "input_tokens" | "output_tokens" | "estimated_cost" | "phase">;

function mkLookup(records: Record<string, Rec>) {
  return (id: string) => records[id];
}

describe("M56 computePhaseTokens", () => {
  it("buckets by phase and sums input/output/cost/calls", () => {
    const records: Record<string, Rec> = {
      "a": { phase: "PLAN_DRAFT", input_tokens: 100, output_tokens: 20, estimated_cost: 0.001 },
      "b": { phase: "EXPLORE",    input_tokens: 200, output_tokens: 40, estimated_cost: 0.002 },
      "c": { phase: "EXPLORE",    input_tokens: 150, output_tokens: 30, estimated_cost: 0.0015 },
      "d": { phase: "ACT",        input_tokens: 500, output_tokens: 200, estimated_cost: 0.01 },
      "e": { phase: "ACT",        input_tokens: 300, output_tokens: 100, estimated_cost: 0.006 },
      "f": { phase: "VERIFY",     input_tokens: 80,  output_tokens: 10, estimated_cost: 0.0005 },
    };
    const out = computePhaseTokens(["a","b","c","d","e","f"], mkLookup(records));

    expect(out.PLAN_DRAFT).toEqual({ input: 100, output: 20, cost: 0.001, calls: 1 });
    expect(out.EXPLORE).toEqual({ input: 350, output: 70, cost: 0.0035, calls: 2 });
    expect(out.ACT).toEqual({ input: 800, output: 300, cost: 0.016, calls: 2 });
    expect(out.VERIFY).toEqual({ input: 80, output: 10, cost: 0.0005, calls: 1 });
  });

  it("treats undefined phase as 'unknown' (legacy / flat-loop runs)", () => {
    const records: Record<string, Rec> = {
      "x": { phase: undefined, input_tokens: 10, output_tokens: 5, estimated_cost: 0.0001 },
      "y": { phase: undefined, input_tokens: 20, output_tokens: 8, estimated_cost: 0.0002 },
    };
    const out = computePhaseTokens(["x","y"], mkLookup(records));
    expect(out.unknown.input).toBe(30);
    expect(out.unknown.output).toBe(13);
    expect(out.unknown.cost).toBeCloseTo(0.0003, 6);
    expect(out.unknown.calls).toBe(2);
  });

  it("treats missing estimated_cost as 0 contribution (catalog with no prices)", () => {
    const records: Record<string, Rec> = {
      "a": { phase: "PLAN_DRAFT", input_tokens: 100, output_tokens: 20, estimated_cost: undefined },
      "b": { phase: "PLAN_DRAFT", input_tokens: 50,  output_tokens: 10, estimated_cost: 0.0001 },
    };
    const out = computePhaseTokens(["a","b"], mkLookup(records));
    // cost only from b
    expect(out.PLAN_DRAFT.cost).toBeCloseTo(0.0001, 6);
    expect(out.PLAN_DRAFT.calls).toBe(2);
    expect(out.PLAN_DRAFT.input).toBe(150);
  });

  it("silently skips ids that the lookup can't resolve (stale audit ring)", () => {
    const records: Record<string, Rec> = {
      "a": { phase: "ACT", input_tokens: 100, output_tokens: 20, estimated_cost: 0.001 },
    };
    const out = computePhaseTokens(["a","gone","also-gone"], mkLookup(records));
    expect(out.ACT.calls).toBe(1);
    expect(Object.keys(out)).toEqual(["ACT"]);
  });

  it("returns empty object for an empty call list", () => {
    expect(computePhaseTokens([], () => undefined)).toEqual({});
  });

  it("supports the full six-phase order (PLAN_DRAFT → FINALIZE)", () => {
    const PHASES = ["PLAN_DRAFT", "EXPLORE", "PLAN_CONFIRM", "ACT", "VERIFY", "FINALIZE"];
    const records: Record<string, Rec> = {};
    const ids: string[] = [];
    for (const p of PHASES) {
      const id = `id-${p}`;
      ids.push(id);
      records[id] = { phase: p, input_tokens: 100, output_tokens: 20, estimated_cost: 0.001 };
    }
    const out = computePhaseTokens(ids, mkLookup(records));
    for (const p of PHASES) {
      expect(out[p], `phase ${p}`).toEqual({ input: 100, output: 20, cost: 0.001, calls: 1 });
    }
  });
});
