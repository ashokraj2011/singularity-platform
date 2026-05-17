/**
 * M25.5 C3 + C5 + C9 — capsule concurrency cap, retry + failure alert, GC.
 *
 * **C3 — per-capability compile concurrency cap.** When 50 concurrent
 * compose-and-respond requests for the same capability arrive after an
 * invalidation, fire-and-forget storeCapsule() would issue 50 parallel
 * mcp-server compile calls. We keep a running counter per capability and
 * bail early once the cap is hit; the cold path still serves raw chunks so
 * the request never blocks.
 *
 * **C5 — Failed-compile retry + alert.** When LLM-mode compile fails the
 * RAW fallback still writes a serviceable capsule, but the operator never
 * learns LLM compile is failing. We track attempts + failures in a sliding
 * window, emit `compose.capsule.compile.alert` to audit-gov when the
 * 60-min failure rate exceeds 5%, and schedule a single 30s retry per
 * signature so transient failures self-heal.
 *
 * **C9 — TTL + GC sweep.** Every capsule gets `expiresAt = now + 30d` on
 * write. A small interval sweeps the table for `expiresAt < now()` OR rows
 * that have been cold (hitCount=0) for > 30d. Keeps storage bounded even
 * if a tenant churns through task signatures.
 */
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { emitAuditEvent } from "../../lib/audit-gov-emit";

const MAX_COMPILE_CONCURRENCY = Math.max(1, Number(process.env.CAPSULE_COMPILE_MAX_CONCURRENCY ?? 5));
const TTL_DAYS                = Math.max(1, Number(process.env.CAPSULE_TTL_DAYS ?? 30));
const COLD_DAYS               = Math.max(1, Number(process.env.CAPSULE_COLD_DAYS ?? 30));
const GC_INTERVAL_MS          = Math.max(60_000, Number(process.env.CAPSULE_GC_INTERVAL_MS ?? 15 * 60_000));

const inflight = new Map<string, number>();

/** Returns true if the caller may start a fresh compile for this capability.
 *  The caller MUST call `releaseCompileSlot()` in a finally block. */
export function tryAcquireCompileSlot(capabilityId: string): boolean {
  const current = inflight.get(capabilityId) ?? 0;
  if (current >= MAX_COMPILE_CONCURRENCY) return false;
  inflight.set(capabilityId, current + 1);
  return true;
}

export function releaseCompileSlot(capabilityId: string): void {
  const current = inflight.get(capabilityId) ?? 0;
  if (current <= 1) inflight.delete(capabilityId);
  else inflight.set(capabilityId, current - 1);
}

export function compileSlotSnapshot(): Record<string, number> {
  return Object.fromEntries(inflight);
}

/** Compute the TTL expiry stamp once per write. Centralised so the route +
 *  the GC sweep stay in sync if the env value changes. */
export function capsuleExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Delete expired-or-cold capsules. Cold = `hitCount=0 AND createdAt < now()-COLD_DAYS`.
 *  Returns number deleted. Best-effort: errors are logged and swallowed. */
export async function gcSweep(): Promise<number> {
  const now    = new Date();
  const coldBefore = new Date(now.getTime() - COLD_DAYS * 24 * 60 * 60 * 1000);
  try {
    const res = await prisma.capabilityCompiledContext.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          {
            AND: [
              { hitCount: 0 },
              { createdAt: { lt: coldBefore } },
            ],
          },
        ],
      },
    });
    if (res.count > 0) {
      logger.info({ deleted: res.count }, "[capsule-gc] sweep removed expired/cold capsules");
    }
    return res.count;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[capsule-gc] sweep failed");
    return 0;
  }
}

let timer: NodeJS.Timeout | null = null;
export function startCapsuleGc(): void {
  if (timer) return;
  // Run once on startup so a long-idle service still cleans on first boot,
  // then on the interval.
  void gcSweep();
  timer = setInterval(() => { void gcSweep(); }, GC_INTERVAL_MS);
  // Don't keep the process alive just for the sweeper.
  timer.unref?.();
  logger.info({ interval_ms: GC_INTERVAL_MS, ttl_days: TTL_DAYS, cold_days: COLD_DAYS, max_concurrency: MAX_COMPILE_CONCURRENCY },
    "[capsule-gc] sweeper started");
}

export function stopCapsuleGc(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  if (failureAlertTimer) { clearInterval(failureAlertTimer); failureAlertTimer = null; }
}

// ─── M25.5 C5 — failure tracking ─────────────────────────────────────────

const FAILURE_WINDOW_MS = Math.max(60_000, Number(process.env.CAPSULE_FAILURE_WINDOW_MS ?? 60 * 60_000)); // 1h
const FAILURE_ALERT_THRESHOLD = Math.max(0, Math.min(1, Number(process.env.CAPSULE_FAILURE_ALERT_RATE ?? 0.05)));
const FAILURE_ALERT_INTERVAL_MS = Math.max(30_000, Number(process.env.CAPSULE_FAILURE_ALERT_INTERVAL_MS ?? 60_000));
const FAILURE_ALERT_MIN_ATTEMPTS = Math.max(1, Number(process.env.CAPSULE_FAILURE_ALERT_MIN_ATTEMPTS ?? 20));
const RETRY_DELAY_MS = Math.max(1_000, Number(process.env.CAPSULE_RETRY_DELAY_MS ?? 30_000));

interface AttemptSample { t: number; success: boolean }
const attempts: AttemptSample[] = [];
let lastAlertAt = 0;
let failureAlertTimer: NodeJS.Timeout | null = null;

function pruneAttempts(now: number): void {
  const cutoff = now - FAILURE_WINDOW_MS;
  while (attempts.length > 0 && attempts[0].t < cutoff) attempts.shift();
}

export function recordCompileAttempt(success: boolean): void {
  const now = Date.now();
  attempts.push({ t: now, success });
  pruneAttempts(now);
}

export function compileFailureSnapshot(): { attempts: number; failures: number; rate: number; windowMinutes: number } {
  const now = Date.now();
  pruneAttempts(now);
  const failures = attempts.reduce((n, a) => n + (a.success ? 0 : 1), 0);
  const total = attempts.length;
  return {
    attempts: total,
    failures,
    rate: total === 0 ? 0 : failures / total,
    windowMinutes: Math.round(FAILURE_WINDOW_MS / 60_000),
  };
}

function maybeAlertFailureRate(): void {
  const snap = compileFailureSnapshot();
  if (snap.attempts < FAILURE_ALERT_MIN_ATTEMPTS) return;
  if (snap.rate <= FAILURE_ALERT_THRESHOLD) return;
  // Throttle — emit at most once per FAILURE_ALERT_INTERVAL_MS.
  const now = Date.now();
  if (now - lastAlertAt < FAILURE_ALERT_INTERVAL_MS) return;
  lastAlertAt = now;
  logger.warn(snap, "[capsule] LLM compile failure rate exceeded threshold");
  // M35.4 — background GC alert; no trace_id available (no per-run context).
  // Passing undefined explicitly satisfies the mandatory trace_id contract and
  // surfaces this gap in the runtime warning logged by emitAuditEvent.
  emitAuditEvent({
    trace_id: undefined,
    source_service: "prompt-composer",
    kind: "compose.capsule.compile.alert",
    severity: "warn",
    payload: {
      attempts: snap.attempts,
      failures: snap.failures,
      rate: snap.rate,
      threshold: FAILURE_ALERT_THRESHOLD,
      window_minutes: snap.windowMinutes,
    },
  });
}

export function startCapsuleFailureAlerts(): void {
  if (failureAlertTimer) return;
  failureAlertTimer = setInterval(() => { maybeAlertFailureRate(); }, FAILURE_ALERT_INTERVAL_MS);
  failureAlertTimer.unref?.();
  logger.info(
    { threshold: FAILURE_ALERT_THRESHOLD, window_ms: FAILURE_WINDOW_MS, alert_interval_ms: FAILURE_ALERT_INTERVAL_MS, retry_delay_ms: RETRY_DELAY_MS },
    "[capsule] failure-alert watcher started",
  );
}

/** Schedule a single LLM compile retry for `taskSignature` after RETRY_DELAY_MS.
 *  De-duplicates: a second call for the same signature while one is pending
 *  is a no-op. Caller passes a thunk so we don't have to thread chunks +
 *  intent through this module (avoiding a hard dep on compose.service). */
const pendingRetries = new Set<string>();
export function scheduleCompileRetry(taskSignature: string, thunk: () => Promise<void>): void {
  if (pendingRetries.has(taskSignature)) return;
  pendingRetries.add(taskSignature);
  const handle = setTimeout(async () => {
    try { await thunk(); }
    catch (err) { logger.warn({ err: (err as Error).message, taskSignature }, "[capsule] retry threw"); }
    finally { pendingRetries.delete(taskSignature); }
  }, RETRY_DELAY_MS);
  handle.unref?.();
}
