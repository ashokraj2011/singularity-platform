/**
 * Stale async-bootstrap detection.
 *
 * A crashed or redeployed async bootstrap worker (BOOTSTRAP_ASYNC=true runs the
 * heavy discovery/distillation work in setImmediate) leaves its
 * CapabilityBootstrapRun stuck `status=RUNNING` forever — there is NO
 * lease/heartbeat like the learning worker has, so the onboarding wizard polls
 * it indefinitely. This module owns the PURE staleness check (no DB, so it is
 * unit-testable); capability.service owns the DB reclaim (reapStaleBootstrapRun).
 */
export const BOOTSTRAP_RUN_STALE_MS = 30 * 60_000;

export const BOOTSTRAP_REAP_ERROR =
  "Bootstrap worker did not complete (process crash or redeploy); the run was reclaimed as FAILED. Retry onboarding.";

/**
 * True when a run is RUNNING but its last activity (updatedAt, bumped at every
 * phase transition; startedAt as a fallback) is older than the stale window — a
 * generous window so a legitimately slow phase isn't reaped. A RUNNING run with
 * no usable timestamp is treated as stale (deny the infinite spinner).
 */
export function isBootstrapRunStale(
  run: { status?: string | null; updatedAt?: Date | string | null; startedAt?: Date | string | null },
  now: number = Date.now(),
): boolean {
  if (String(run.status ?? "").toUpperCase() !== "RUNNING") return false;
  const raw = run.updatedAt ?? run.startedAt ?? null;
  const lastActivity = raw instanceof Date ? raw.getTime() : Date.parse(String(raw ?? ""));
  if (!Number.isFinite(lastActivity)) return true;
  return now - lastActivity > BOOTSTRAP_RUN_STALE_MS;
}
