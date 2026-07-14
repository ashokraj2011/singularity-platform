import { describe, it, expect } from "vitest";
import {
  poolEstimates,
  toBetaPrior,
  betaStats,
  applyEvidence,
  foldEvidence,
  decayOnRead,
  ignoranceRank,
  expectedInfoGain,
  converged,
  TIER_CAP,
  UNIFORM_PRIOR,
} from "../src/modules/rooms/belief";

describe("poolEstimates", () => {
  it("weights the mean by calibration and reports disagreement as variance", () => {
    const p = poolEstimates([{ probability: 1 }, { probability: 0 }]);
    expect(p.mean).toBeCloseTo(0.5, 6);
    expect(p.variance).toBeGreaterThan(0); // maximal disagreement
    expect(p.n).toBe(2);

    const agree = poolEstimates([{ probability: 0.8 }, { probability: 0.8 }]);
    expect(agree.mean).toBeCloseTo(0.8, 6);
    expect(agree.variance).toBeCloseTo(0, 6); // no disagreement

    const weighted = poolEstimates([{ probability: 1, weight: 3 }, { probability: 0, weight: 1 }]);
    expect(weighted.mean).toBeCloseTo(0.75, 6); // 3:1 toward the calibrated estimator
  });

  it("degrades to a uniform mean with no estimates", () => {
    expect(poolEstimates([]).mean).toBe(0.5);
  });
});

describe("toBetaPrior / betaStats", () => {
  it("regularizes toward uniform so pooled opinion never asserts certainty", () => {
    const b = toBetaPrior(1.0, 2); // everyone says 'certainly true'
    expect(b.alpha).toBeCloseTo(3, 6); // 1 (uniform) + 1*2
    expect(b.beta).toBeCloseTo(1, 6);
    expect(betaStats(b).mean).toBeLessThan(1); // still not certainty
    expect(betaStats(b).mean).toBeGreaterThan(0.5);
  });
});

describe("applyEvidence / foldEvidence", () => {
  it("caps pseudo-counts by source tier (production far outweighs an agent sim)", () => {
    const prod = applyEvidence(UNIFORM_PRIOR, { id: "e1", supports: true, tier: "PRODUCTION" });
    const agent = applyEvidence(UNIFORM_PRIOR, { id: "e2", supports: true, tier: "AGENT" });
    expect(prod.alpha).toBe(1 + TIER_CAP.PRODUCTION);
    expect(agent.alpha).toBe(1 + TIER_CAP.AGENT);
    expect(prod.alpha).toBeGreaterThan(agent.alpha);
  });

  it("OPINION evidence never moves a posterior (only evidence travels)", () => {
    const after = applyEvidence({ alpha: 2, beta: 3 }, { id: "o1", supports: true, tier: "OPINION" });
    expect(after).toEqual({ alpha: 2, beta: 3 });
  });

  it("caps a requested weight to the tier cap", () => {
    const after = applyEvidence(UNIFORM_PRIOR, { id: "e", supports: false, tier: "SIMULATION", weight: 999 });
    expect(after.beta).toBe(1 + TIER_CAP.SIMULATION);
  });

  it("is idempotent by evidence identity — the same observation counts once", () => {
    const ev = { id: "same", supports: true, tier: "EXPERIMENT" as const };
    const once = foldEvidence(UNIFORM_PRIOR, [ev]);
    const thrice = foldEvidence(UNIFORM_PRIOR, [ev, ev, ev]);
    expect(thrice).toEqual(once);
  });
});

describe("decayOnRead", () => {
  it("relaxes a confident posterior back toward uniform as evidence ages", () => {
    const confident = { alpha: 21, beta: 3 };
    const fresh = decayOnRead(confident, 0, "MARKET");
    const old = decayOnRead(confident, 90, "MARKET"); // one half-life
    const ancient = decayOnRead(confident, 3650, "MARKET");
    expect(fresh).toEqual(confident);
    expect(betaStats(old).concentration).toBeLessThan(betaStats(confident).concentration);
    expect(betaStats(old).concentration).toBeGreaterThan(betaStats(ancient).concentration);
    expect(betaStats(ancient).mean).toBeCloseTo(0.5, 1); // → ignorance
  });

  it("technical claims decay far slower than market claims", () => {
    const b = { alpha: 21, beta: 3 };
    const market = betaStats(decayOnRead(b, 180, "MARKET")).concentration;
    const technical = betaStats(decayOnRead(b, 180, "TECHNICAL")).concentration;
    expect(technical).toBeGreaterThan(market);
  });
});

describe("ignoranceRank", () => {
  it("surfaces the most contested claims first (highest disagreement)", () => {
    const ranked = ignoranceRank([
      { id: "a", disagreement: 0.01 },
      { id: "b", disagreement: 0.25 },
      { id: "c", disagreement: 0.10 },
    ] as Array<{ id: string; disagreement: number }>);
    expect(ranked.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});

describe("expectedInfoGain / converged", () => {
  it("a higher-tier probe yields more expected information", () => {
    const prior = { alpha: 2, beta: 2 };
    expect(expectedInfoGain(prior, "PRODUCTION")).toBeGreaterThan(expectedInfoGain(prior, "AGENT"));
    expect(expectedInfoGain(prior, "OPINION")).toBe(0);
  });
  it("converges when the best probe's gain per hour falls below the bar", () => {
    expect(converged(0.001, 0.01)).toBe(true);
    expect(converged(0.05, 0.01)).toBe(false);
  });
});
