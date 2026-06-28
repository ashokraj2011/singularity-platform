/**
 * Pluggable replay-nonce store for ToolInvocationGrant verification (#21).
 *
 * A grant is single-use: its 128-bit nonce is recorded when honored, and any
 * later request carrying the same nonce is a replay. `consume` does the
 * check-and-record ATOMICALLY (so two concurrent requests can't both win).
 *
 * Backends:
 *  - "memory" (default): in-process Map. Correct + sufficient for a SINGLE
 *    mcp-server instance — the bare-metal all-in-one and the laptop mcp-server
 *    (which has no cloud-DB reach). Each process protects its own dispatch.
 *  - "postgres": a shared table, for a multi-REPLICA CLOUD mcp-server where a
 *    replay routed to a sibling replica would slip past per-process memory.
 *    Atomic via INSERT ... ON CONFLICT DO NOTHING (the SETNX equivalent). On a
 *    DB error it FAILS OPEN to in-memory (per-process) + logs once — availability
 *    over strictness, matching the platform's "never block a dispatch on an infra
 *    hiccup" posture; per-process replay protection still applies meanwhile.
 */
import { Pool } from "pg";
import { config } from "../config";
import { log } from "../shared/log";

export interface NonceStore {
  /**
   * Atomically record `nonce` (retained until `expiresAtMs`) iff it is unseen.
   * Returns true when the nonce was fresh (recorded now), false when it had
   * already been consumed — i.e. a replay.
   */
  consume(nonce: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
  /** Test seam — drop all recorded nonces. */
  reset(): Promise<void>;
}

class InMemoryNonceStore implements NonceStore {
  private readonly store = new Map<string, number>(); // nonce -> expiresAtMs
  private nextSweepAtMs = 0;
  private static readonly SWEEP_INTERVAL_MS = 60_000;

  private sweep(nowMs: number): void {
    if (nowMs < this.nextSweepAtMs) return;
    for (const [nonce, expMs] of this.store) {
      if (expMs <= nowMs) this.store.delete(nonce);
    }
    this.nextSweepAtMs = nowMs + InMemoryNonceStore.SWEEP_INTERVAL_MS;
  }

  // Node is single-threaded per process, so this check-then-set is atomic
  // relative to other consume() calls — no await between has() and set().
  async consume(nonce: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    this.sweep(nowMs);
    if (this.store.has(nonce)) return false;
    this.store.set(nonce, expiresAtMs);
    return true;
  }

  async reset(): Promise<void> {
    this.store.clear();
    this.nextSweepAtMs = 0;
  }
}

class PostgresNonceStore implements NonceStore {
  private readonly pool: Pool;
  private readonly fallback = new InMemoryNonceStore();
  private schemaReady: Promise<void> | null = null;
  private degraded = false;
  private nextCleanupAtMs = 0;
  private static readonly CLEANUP_INTERVAL_MS = 300_000;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 4 });
    // A pool 'error' on an idle client would otherwise crash the process.
    this.pool.on("error", (err) => {
      if (!this.degraded) log.warn({ err: err.message }, "[nonce-store] postgres pool error");
    });
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.pool
        .query(
          `CREATE TABLE IF NOT EXISTS mcp_tool_grant_nonce (
             nonce TEXT PRIMARY KEY,
             expires_at TIMESTAMPTZ NOT NULL
           )`,
        )
        .then(() => undefined)
        .catch((err) => {
          // Reset so a later call retries the DDL rather than caching the failure.
          this.schemaReady = null;
          throw err;
        });
    }
    return this.schemaReady;
  }

  private async cleanupExpired(nowMs: number): Promise<void> {
    if (nowMs < this.nextCleanupAtMs) return;
    this.nextCleanupAtMs = nowMs + PostgresNonceStore.CLEANUP_INTERVAL_MS;
    await this.pool.query("DELETE FROM mcp_tool_grant_nonce WHERE expires_at < now()").catch(() => undefined);
  }

  async consume(nonce: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    try {
      await this.ensureSchema();
      const res = await this.pool.query(
        `INSERT INTO mcp_tool_grant_nonce (nonce, expires_at)
         VALUES ($1, to_timestamp($2 / 1000.0))
         ON CONFLICT (nonce) DO NOTHING`,
        [nonce, expiresAtMs],
      );
      void this.cleanupExpired(nowMs);
      this.degraded = false;
      return (res.rowCount ?? 0) === 1; // 1 = inserted (fresh); 0 = conflict (replay)
    } catch (err) {
      if (!this.degraded) {
        this.degraded = true;
        log.warn(
          { err: (err as Error).message },
          "[nonce-store] postgres unavailable; falling back to in-memory replay protection (per-process only)",
        );
      }
      return this.fallback.consume(nonce, expiresAtMs, nowMs);
    }
  }

  async reset(): Promise<void> {
    await this.fallback.reset();
    await this.pool.query("TRUNCATE mcp_tool_grant_nonce").catch(() => undefined);
  }
}

let _store: NonceStore | null = null;

/** The active replay-nonce store (singleton), selected from config. */
export function getNonceStore(): NonceStore {
  if (_store) return _store;
  const url = config.MCP_NONCE_DATABASE_URL;
  if (config.MCP_NONCE_STORE === "postgres" && url) {
    log.info("[nonce-store] using postgres-backed replay store (multi-replica safe)");
    _store = new PostgresNonceStore(url);
  } else {
    if (config.MCP_NONCE_STORE === "postgres" && !url) {
      log.warn("[nonce-store] MCP_NONCE_STORE=postgres but MCP_NONCE_DATABASE_URL is unset; using in-memory store");
    }
    _store = new InMemoryNonceStore();
  }
  return _store;
}

/** Test seam — reset the active store and clear the singleton. */
export async function __resetNonceStoreForTest(): Promise<void> {
  if (_store) await _store.reset();
  _store = null;
}
