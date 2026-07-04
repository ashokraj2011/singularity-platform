import assert from "assert";
import { capsuleGcConfig } from "./capsule-gc.config";

// capsule-gc transitively imports the composer config, which strictly validates
// env at load. Provide dummy connection strings (validation never connects) so
// this test is self-contained in the test:contracts chain.
process.env.DATABASE_URL ??= "postgresql://u:p@127.0.0.1:5432/db";
process.env.DATABASE_URL_RUNTIME_READ ??= "postgresql://u:p@127.0.0.1:5432/db";
// Set the size cap BEFORE loading the module — capsule-gc reads CAPSULE_MAX_CHARS
// at import time. (require after the env assignment; ES import would hoist.)
// Use a value above the built-in 1_000 floor.
process.env.CAPSULE_COMPILE_MAX_CONCURRENCY = "bad";
process.env.CAPSULE_TTL_DAYS = "bad";
process.env.CAPSULE_COLD_DAYS = "9999";
process.env.CAPSULE_GC_INTERVAL_MS = "bad";
process.env.CAPSULE_MAX_CHARS = "2000";
process.env.CAPSULE_FAILURE_WINDOW_MS = "bad";
process.env.CAPSULE_FAILURE_ALERT_RATE = "2";
process.env.CAPSULE_FAILURE_ALERT_INTERVAL_MS = "bad";
process.env.CAPSULE_FAILURE_ALERT_MIN_ATTEMPTS = "0";
process.env.CAPSULE_RETRY_DELAY_MS = "999999999";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { capsuleTooLarge, capsuleExpiry } = require("./capsule-gc") as typeof import("./capsule-gc");

function main(): void {
  // ── size hardening (P2 #22) ──────────────────────────────────────────────
  assert.equal(capsuleTooLarge("x".repeat(1999)), false, "under cap → cacheable");
  assert.equal(capsuleTooLarge("x".repeat(2000)), false, "exactly at cap → cacheable");
  assert.equal(capsuleTooLarge("x".repeat(2001)), true, "over cap → skip caching");
  assert.equal(capsuleTooLarge(""), false, "empty → cacheable");

  // ── TTL stamp sanity ─────────────────────────────────────────────────────
  const base = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(
    capsuleExpiry(base).toISOString(),
    "2026-01-31T00:00:00.000Z",
    "invalid CAPSULE_TTL_DAYS falls back to 30d",
  );

  // ── env hardening ────────────────────────────────────────────────────────
  const cfg = capsuleGcConfig();
  assert.equal(cfg.maxCompileConcurrency, 5, "bad concurrency falls back");
  assert.equal(cfg.ttlDays, 30, "bad TTL falls back");
  assert.equal(cfg.coldDays, 365, "cold days clamps");
  assert.equal(cfg.gcIntervalMs, 15 * 60_000, "bad interval falls back");
  assert.equal(cfg.maxCapsuleChars, 2000, "valid size cap preserved");
  assert.equal(cfg.failureWindowMs, 60 * 60_000, "bad failure window falls back");
  assert.equal(cfg.failureAlertThreshold, 1, "failure threshold clamps");
  assert.equal(cfg.failureAlertIntervalMs, 60_000, "bad alert interval falls back");
  assert.equal(cfg.failureAlertMinAttempts, 20, "sub-min attempts falls back");
  assert.equal(cfg.retryDelayMs, 60 * 60_000, "retry delay clamps");

  console.log("capsule-gc.contract.test.ts: OK");
}

main();
