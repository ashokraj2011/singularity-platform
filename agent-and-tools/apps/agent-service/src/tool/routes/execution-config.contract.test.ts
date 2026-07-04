import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { boundedInteger } from "../lib/env";

const executionSource = readFileSync(path.resolve(__dirname, "execution.ts"), "utf8");

assert.equal(boundedInteger(undefined, { defaultValue: 30_000, min: 1_000, max: 300_000 }), 30_000);
assert.equal(boundedInteger("", { defaultValue: 30_000, min: 1_000, max: 300_000 }), 30_000);
assert.equal(boundedInteger("NaN", { defaultValue: 30_000, min: 1_000, max: 300_000 }), 30_000);
assert.equal(boundedInteger("999", { defaultValue: 30_000, min: 1_000, max: 300_000 }), 30_000);
assert.equal(boundedInteger("1200.9", { defaultValue: 30_000, min: 1_000, max: 300_000 }), 1200);
assert.equal(boundedInteger("999999999", { defaultValue: 30_000, min: 1_000, max: 300_000 }), 300_000);
assert.throws(
  () => boundedInteger("5", { defaultValue: 10, min: 20, max: 30 }),
  /invalid bounded integer options/,
);

assert(
  executionSource.includes('boundedEnvInteger("TOOL_SERVER_ENDPOINT_TIMEOUT_MS"'),
  "tool-service server endpoint timeout must use bounded env parsing",
);
assert(
  executionSource.includes("defaultValue: 30_000") &&
    executionSource.includes("min: 1_000") &&
    executionSource.includes("max: 300_000"),
  "tool-service server endpoint timeout bounds must stay documented in code",
);
assert(
  executionSource.includes("signal: AbortSignal.timeout(SERVER_TOOL_ENDPOINT_TIMEOUT_MS)"),
  "tool-service server endpoint fetches must use the bounded timeout constant",
);
assert.doesNotMatch(
  executionSource,
  /Number\(process\.env\.TOOL_SERVER_ENDPOINT_TIMEOUT_MS/,
  "tool-service server endpoint timeout must not parse the env var directly",
);

console.log("tool-service execution config contract tests passed");
