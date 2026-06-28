import assert from "assert";

// capsule-gc transitively imports the composer config, which strictly validates
// env at load. Provide dummy connection strings (validation never connects) so
// this test is self-contained in the test:contracts chain.
process.env.DATABASE_URL ??= "postgresql://u:p@127.0.0.1:5432/db";
process.env.DATABASE_URL_RUNTIME_READ ??= "postgresql://u:p@127.0.0.1:5432/db";
// Set the size cap BEFORE loading the module — capsule-gc reads CAPSULE_MAX_CHARS
// at import time. (require after the env assignment; ES import would hoist.)
// Use a value above the built-in 1_000 floor (Math.max(1_000, …)).
process.env.CAPSULE_MAX_CHARS = "2000";
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
  assert.ok(capsuleExpiry(base).getTime() > base.getTime(), "expiry is in the future");

  console.log("capsule-gc.contract.test.ts: OK");
}

main();
