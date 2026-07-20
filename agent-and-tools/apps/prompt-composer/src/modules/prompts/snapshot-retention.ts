/**
 * D3 — retention for stored prompt text.
 *
 * `PromptAssemblyLayer.contentSnapshot` holds the FULL text of every composed
 * layer, uncapped and unmasked. It is the highest-value data this service
 * stores, and keeping it forever is a liability with no matching benefit:
 * the operational reasons to read raw prompt text (debugging a bad run,
 * reviewing what an agent was told) all expire within weeks.
 *
 * So we age the TEXT out while keeping the RECEIPT. The sweep NULLs
 * `contentSnapshot` on layers whose parent assembly is older than the TTL and
 * touches nothing else. `layerHash` in particular survives, which is what
 * keeps the row auditable after the text is gone — "was this the same prompt
 * as that one?" stays answerable by comparing hashes, and "which layers, in
 * what order, included or excluded, and why" stays fully intact.
 *
 * Rows are UPDATED, never deleted. Deleting them would break the
 * PromptAssembly → layers structure that the trace-spine viewer and
 * audit-replay joins depend on.
 */
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { snapshotRetentionConfig } from "./snapshot-retention.config";

const RETENTION_CONFIG = snapshotRetentionConfig();
const TTL_DAYS          = RETENTION_CONFIG.ttlDays;
const SWEEP_INTERVAL_MS = RETENTION_CONFIG.sweepIntervalMs;

/**
 * The slice of the Prisma client this sweep needs.
 *
 * Declared structurally, and satisfied by the real client without a cast, so
 * two things hold at once: the production path stays type-checked against
 * actual Prisma types, and the contract test can drive the real sweep logic
 * against an in-memory double with no live database. Note it exposes ONLY
 * `updateMany` — there is deliberately no way to reach a delete from here.
 */
export interface SnapshotRetentionClient {
  promptAssemblyLayer: {
    updateMany(args: {
      where: {
        contentSnapshot?: { not: null };
        promptAssembly?: { createdAt: { lt: Date } };
      };
      data: { contentSnapshot: null };
    }): Promise<{ count: number }>;
  };
}

/** Layers belonging to assemblies created before this instant are due. */
export function snapshotCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * NULL expired `contentSnapshot` values. Returns the number of layers purged.
 * Best-effort: errors are logged and swallowed so a retention hiccup never
 * takes the service down.
 */
export async function purgeExpiredSnapshots(
  opts: { now?: Date; client?: SnapshotRetentionClient } = {},
): Promise<number> {
  const client = opts.client ?? prisma;
  const cutoff = snapshotCutoff(opts.now ?? new Date());
  try {
    const res = await client.promptAssemblyLayer.updateMany({
      where: {
        // Skip rows already purged, otherwise every sweep rewrites the whole
        // historical table and the reported count never settles to zero.
        contentSnapshot: { not: null },
        // PromptAssemblyLayer carries no timestamp of its own, so age comes
        // from the parent assembly through the relation.
        promptAssembly: { createdAt: { lt: cutoff } },
      },
      // Exactly one column. layerHash and every other field are untouched.
      data: { contentSnapshot: null },
    });
    if (res.count > 0) {
      logger.info(
        { purged: res.count, cutoff: cutoff.toISOString(), ttl_days: TTL_DAYS },
        "[prompt-snapshot-retention] nulled expired prompt snapshots",
      );
    }
    return res.count;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "[prompt-snapshot-retention] sweep failed",
    );
    return 0;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startSnapshotRetention(): void {
  if (timer) return;
  // Sweep once at boot so a service that was down past its TTL still
  // catches up, then on the interval.
  void purgeExpiredSnapshots();
  timer = setInterval(() => { void purgeExpiredSnapshots(); }, SWEEP_INTERVAL_MS);
  // Don't hold the process open just for the sweeper.
  timer.unref?.();
  logger.info(
    { interval_ms: SWEEP_INTERVAL_MS, ttl_days: TTL_DAYS },
    "[prompt-snapshot-retention] sweeper started",
  );
}

export function stopSnapshotRetention(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
