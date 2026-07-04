import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/lib/platform-registry/register.ts", "utf8");
const pkg = readFileSync("package.json", "utf8");

assert.match(
  source,
  /function boundedSeconds\(raw: unknown, defaultValue: number, min: number, max: number\): number/,
  "platform-registry registration should use a local bounded-seconds parser",
);
assert.match(
  source,
  /const REGISTER_TIMEOUT_MS = boundedSeconds\(process\.env\.PLATFORM_REGISTRY_REGISTER_TIMEOUT_SEC, 5, 1, 300\) \* 1000/,
  "registration timeout must come from bounded PLATFORM_REGISTRY_REGISTER_TIMEOUT_SEC",
);
assert.match(
  source,
  /const HEARTBEAT_TIMEOUT_MS = boundedSeconds\(process\.env\.PLATFORM_REGISTRY_HEARTBEAT_TIMEOUT_SEC, 3, 1, 300\) \* 1000/,
  "heartbeat timeout must come from bounded PLATFORM_REGISTRY_HEARTBEAT_TIMEOUT_SEC",
);
assert.match(
  source,
  /AbortSignal\.timeout\(REGISTER_TIMEOUT_MS\)/,
  "registration POST should use the bounded registration timeout",
);
assert.match(
  source,
  /AbortSignal\.timeout\(HEARTBEAT_TIMEOUT_MS\)/,
  "heartbeat POST should use the bounded heartbeat timeout",
);
assert.doesNotMatch(
  source,
  /AbortSignal\.timeout\(5000\)/,
  "registration POST must not hardcode milliseconds",
);
assert.doesNotMatch(
  source,
  /AbortSignal\.timeout\(3000\)/,
  "heartbeat POST must not hardcode milliseconds",
);
assert.match(
  pkg,
  /platform-registry\/register-config\.contract\.test\.ts/,
  "MCP contract suite must include platform-registry timeout config coverage",
);

console.log("mcp platform-registry config contract tests passed");
