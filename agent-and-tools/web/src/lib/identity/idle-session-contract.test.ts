import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const idleSession = read("src/lib/identity/idleSession.ts");

assert.match(
  idleSession,
  /const DEFAULT_IDLE_MINUTES = 30;/,
  "idle session should keep the 30 minute default",
);

assert.match(
  idleSession,
  /const MIN_IDLE_MINUTES = 1;/,
  "idle session should reject sub-minute public env values",
);

assert.match(
  idleSession,
  /const MAX_IDLE_MINUTES = 12 \* 60;/,
  "idle session should cap idle timeout at the IAM token lifetime envelope",
);

assert.match(
  idleSession,
  /export function boundedIdleMinutes\(raw = process\.env\.NEXT_PUBLIC_SESSION_IDLE_MINUTES\): number/,
  "idle session should expose a bounded parser for NEXT_PUBLIC_SESSION_IDLE_MINUTES",
);

assert.match(
  idleSession,
  /if \(!Number\.isFinite\(parsed\) \|\| parsed < MIN_IDLE_MINUTES\) return DEFAULT_IDLE_MINUTES;/,
  "idle session parser should reject malformed, non-finite, and sub-minute values",
);

assert.match(
  idleSession,
  /return Math\.min\(MAX_IDLE_MINUTES, Math\.trunc\(parsed\)\);/,
  "idle session parser should truncate fractions and cap oversized values",
);

assert.match(
  idleSession,
  /export function idleLimitMs\(\): number \{[\s\S]*?return boundedIdleMinutes\(\) \* 60_000;[\s\S]*?\}/,
  "idleLimitMs should only use the bounded parser",
);

assert.doesNotMatch(
  idleSession,
  /Number\(process\.env\.NEXT_PUBLIC_SESSION_IDLE_MINUTES\)/,
  "idleLimitMs must not parse the public env var directly",
);

console.log("idle session contract tests passed");
