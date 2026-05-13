/**
 * M25.5 C3 + C9 — capsule concurrency cap + GC.
 *
 * **C3 — per-capability compile concurrency cap.** When 50 concurrent
 * compose-and-respond requests for the same capability arrive after an
 * invalidation, fire-and-forget storeCapsule() would issue 50 parallel
 * mcp-server compile calls. We keep a running counter per capability and
 * bail early once the cap is hit; the cold path still serves raw chunks so
 * the request never blocks.
 *
 * **C9 — TTL + GC sweep.** Every capsule gets `expiresAt = now + 30d` on
 * write. A small interval sweeps the table for `expiresAt < now()` OR rows
 * that have been cold (hitCount=0) for > 30d. Keeps storage bounded even
 * if a tenant churns through task signatures.
 */
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";

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
}
