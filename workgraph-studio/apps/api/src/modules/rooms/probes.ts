/**
 * Probe economics — the pure helpers behind the stopping rule. Exploration is funded by information
 * gain PER UNIT COST, so a probe's value is its expected info gain divided by what it costs to run;
 * a room converges when the best remaining probe's gain-per-hour falls below a declared bar. No I/O.
 */
import { converged, type EvidenceTier } from "./belief";

/** Nominal hours a probe of each tier costs — the cheap synthetic probes are near-free, reality is dear.
 *  (A rough cost proxy for gain-per-hour; a real cost estimate can replace it later.) */
export const PROBE_HOURS: Record<EvidenceTier, number> = {
  PRODUCTION: 40,
  EXPERIMENT: 8,
  SIMULATION: 2,
  AGENT: 1,
  OPINION: 1,
};

/** Default EIG-per-hour bar below which the best remaining probe isn't worth running → converge. */
export const DEFAULT_CONVERGENCE_BAR = 0.0005;

export function gainPerHour(eig: number, tier: EvidenceTier): number {
  return Math.max(0, eig) / (PROBE_HOURS[tier] ?? 1);
}

export interface ProbeGain {
  eig: number | null;
  tier: EvidenceTier;
  status: string; // only OPEN probes count toward "is there anything left worth doing?"
}

/** The best gain-per-hour among a room's OPEN probes (0 when nothing is open). */
export function bestOpenGainPerHour(probes: ProbeGain[]): number {
  return probes
    .filter((p) => p.status === "OPEN")
    .reduce((best, p) => Math.max(best, gainPerHour(p.eig ?? 0, p.tier)), 0);
}

/** The room-level convergence readout: the best remaining gain-per-hour and whether it's below the bar. */
export function roomConvergence(probes: ProbeGain[], bar: number = DEFAULT_CONVERGENCE_BAR): { bestGainPerHour: number; converged: boolean; openProbes: number } {
  const openProbes = probes.filter((p) => p.status === "OPEN").length;
  const best = bestOpenGainPerHour(probes);
  return { bestGainPerHour: best, converged: openProbes > 0 && converged(best, bar), openProbes };
}
