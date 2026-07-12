import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isBootstrapRunStale,
  BOOTSTRAP_RUN_STALE_MS,
  BOOTSTRAP_REAP_ERROR,
} from "./capability-bootstrap-reaper";

const NOW = Date.parse("2026-07-12T12:00:00.000Z");
const minAgo = (n: number) => new Date(NOW - n * 60_000);

// ── Pure staleness check ──────────────────────────────────────────────────
// Non-RUNNING → never stale (nothing to reap).
assert.equal(isBootstrapRunStale({ status: "COMPLETED", updatedAt: minAgo(120) }, NOW), false);
assert.equal(isBootstrapRunStale({ status: "FAILED", updatedAt: minAgo(120) }, NOW), false);
// RUNNING + recent activity → not stale (inside the window).
assert.equal(isBootstrapRunStale({ status: "RUNNING", updatedAt: minAgo(5) }, NOW), false);
assert.equal(isBootstrapRunStale({ status: "RUNNING", updatedAt: minAgo(29) }, NOW), false);
// RUNNING + activity older than the window → stale (worker died).
assert.equal(isBootstrapRunStale({ status: "RUNNING", updatedAt: minAgo(31) }, NOW), true);
assert.equal(isBootstrapRunStale({ status: "RUNNING", updatedAt: minAgo(600) }, NOW), true);
// Falls back to startedAt when updatedAt is absent.
assert.equal(isBootstrapRunStale({ status: "RUNNING", startedAt: minAgo(45) }, NOW), true);
assert.equal(isBootstrapRunStale({ status: "RUNNING", startedAt: minAgo(2) }, NOW), false);
// Missing / unparseable timestamp on a RUNNING run → stale (deny the infinite spinner).
assert.equal(isBootstrapRunStale({ status: "RUNNING" }, NOW), true);
assert.equal(isBootstrapRunStale({ status: "RUNNING", updatedAt: "not-a-date" }, NOW), true);
// Case-insensitive status; ISO-string timestamps accepted.
assert.equal(isBootstrapRunStale({ status: "running", updatedAt: minAgo(60).toISOString() }, NOW), true);
assert.equal(BOOTSTRAP_RUN_STALE_MS, 30 * 60_000);
assert.ok(BOOTSTRAP_REAP_ERROR.length > 0);

// ── Structural: capability.service wires the reaper into getBootstrapRun ───
const svc = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");
assert.match(
  svc,
  /async getBootstrapRun\([\s\S]*?if \(isBootstrapRunStale\(run\)\)[\s\S]*?reapStaleBootstrapRun\(run\.id\)/,
  "getBootstrapRun must reap a stale RUNNING run when polled",
);
// The reclaim is idempotent — updateMany guarded on status:\"RUNNING\" so it can't
// race a worker that just completed.
assert.match(
  svc,
  /reapStaleBootstrapRun[\s\S]*?updateMany\(\{[\s\S]*?where: \{ id: runId, status: "RUNNING" \}[\s\S]*?status: "FAILED"/,
  "reapStaleBootstrapRun must claim only a still-RUNNING run",
);

console.log("agent-runtime bootstrap-reaper contract tests passed");
