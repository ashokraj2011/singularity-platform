import { boundedIntEnv } from "../../shared/env-bounds";

/** D3 — bounds for the PromptAssemblyLayer.contentSnapshot retention sweep.
 *  Read through a helper (never `Number(process.env.…)` inline) so a garbage
 *  env value degrades to the documented default instead of producing a NaN
 *  cutoff that would match every row. */
export function snapshotRetentionConfig() {
  return {
    // Days of prompt text kept before the snapshot is nulled. Floor of 1 —
    // a 0-day TTL would purge snapshots the moment they are written, which
    // is never what an operator means and is unrecoverable.
    ttlDays: boundedIntEnv("PROMPT_SNAPSHOT_TTL_DAYS", 30, 1, 3_650),
    // Sweep cadence. Retention is a slow-moving obligation; hourly-ish is
    // plenty and keeps the write amplification off the hot path.
    sweepIntervalMs: boundedIntEnv(
      "PROMPT_SNAPSHOT_SWEEP_INTERVAL_MS",
      6 * 60 * 60_000,
      60_000,
      24 * 60 * 60_000,
    ),
  };
}
