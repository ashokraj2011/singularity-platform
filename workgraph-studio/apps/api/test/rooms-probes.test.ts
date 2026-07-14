import { describe, it, expect } from "vitest";
import { gainPerHour, bestOpenGainPerHour, roomConvergence, PROBE_HOURS, DEFAULT_CONVERGENCE_BAR } from "../src/modules/rooms/probes";

describe("probe economics", () => {
  it("gainPerHour divides EIG by the tier's nominal hours", () => {
    expect(gainPerHour(0.08, "AGENT")).toBeCloseTo(0.08 / PROBE_HOURS.AGENT);
    expect(gainPerHour(0.08, "PRODUCTION")).toBeCloseTo(0.08 / PROBE_HOURS.PRODUCTION);
    // a cheap agent probe with the same EIG beats a costly production one on gain-per-hour
    expect(gainPerHour(0.08, "AGENT")).toBeGreaterThan(gainPerHour(0.08, "PRODUCTION"));
    expect(gainPerHour(-1, "AGENT")).toBe(0); // negative EIG floored
  });

  it("bestOpenGainPerHour considers only OPEN probes", () => {
    const probes = [
      { eig: 0.02, tier: "AGENT" as const, status: "OPEN" },
      { eig: 0.5, tier: "AGENT" as const, status: "RESOLVED" }, // ignored — already done
      { eig: 0.04, tier: "SIMULATION" as const, status: "OPEN" },
    ];
    expect(bestOpenGainPerHour(probes)).toBeCloseTo(gainPerHour(0.02, "AGENT"));
  });
});

describe("roomConvergence — the stopping rule", () => {
  it("does NOT converge while an open probe clears the bar", () => {
    const r = roomConvergence([{ eig: 0.05, tier: "AGENT", status: "OPEN" }]);
    expect(r.openProbes).toBe(1);
    expect(r.converged).toBe(false);
  });
  it("converges when the best open probe's gain-per-hour falls below the bar", () => {
    const tiny = DEFAULT_CONVERGENCE_BAR * PROBE_HOURS.PRODUCTION * 0.5; // gain/hr < bar
    const r = roomConvergence([{ eig: tiny, tier: "PRODUCTION", status: "OPEN" }]);
    expect(r.converged).toBe(true);
  });
  it("does not 'converge' a room with no open probes (nothing was explored)", () => {
    const r = roomConvergence([{ eig: 0.5, tier: "AGENT", status: "RESOLVED" }]);
    expect(r.openProbes).toBe(0);
    expect(r.converged).toBe(false);
  });
});
