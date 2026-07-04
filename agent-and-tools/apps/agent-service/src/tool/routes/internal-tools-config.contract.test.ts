import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { boundedInteger, boundedNumber } from "../lib/env";

const internalToolsSource = readFileSync(path.resolve(__dirname, "internal-tools.ts"), "utf8");
const packageSource = readFileSync(path.resolve(process.cwd(), "package.json"), "utf8");

assert.equal(boundedInteger(undefined, { defaultValue: 30, min: 1, max: 3650 }), 30);
assert.equal(boundedInteger("", { defaultValue: 30, min: 1, max: 3650 }), 30);
assert.equal(boundedInteger("bad", { defaultValue: 30, min: 1, max: 3650 }), 30);
assert.equal(boundedInteger("0", { defaultValue: 30, min: 1, max: 3650 }), 30);
assert.equal(boundedInteger("45.9", { defaultValue: 30, min: 1, max: 3650 }), 45);
assert.equal(boundedInteger("99999", { defaultValue: 30, min: 1, max: 3650 }), 3650);

assert.equal(boundedNumber(undefined, { defaultValue: 0.2, min: 0, max: 1 }), 0.2);
assert.equal(boundedNumber("", { defaultValue: 0.2, min: 0, max: 1 }), 0.2);
assert.equal(boundedNumber("bad", { defaultValue: 0.2, min: 0, max: 1 }), 0.2);
assert.equal(boundedNumber("-0.1", { defaultValue: 0.2, min: 0, max: 1 }), 0.2);
assert.equal(boundedNumber("1.5", { defaultValue: 0.2, min: 0, max: 1 }), 1);
assert.equal(boundedNumber("0.35", { defaultValue: 0.2, min: 0, max: 1 }), 0.35);
assert.throws(
  () => boundedNumber("0.5", { defaultValue: 2, min: 0, max: 1 }),
  /invalid bounded number options/,
);

assert.match(
  internalToolsSource,
  /const INTERNAL_TOOLS_CONFIG = internalToolsConfig\(\);/,
  "internal tools retrieval must read bounded config once",
);
assert.match(
  internalToolsSource,
  /INTERNAL_TOOLS_CONFIG\.recencyBoostDays/,
  "recency days must come from bounded config",
);
assert.match(
  internalToolsSource,
  /INTERNAL_TOOLS_CONFIG\.recencyBoostMax/,
  "recency boost must come from bounded config",
);
assert.doesNotMatch(
  internalToolsSource,
  /Number\(process\.env\.EMBEDDING_RECENCY_/,
  "internal tools must not parse embedding recency env directly",
);
assert.match(
  packageSource,
  /internal-tools-config\.contract\.test\.ts/,
  "agent-service contract suite must include internal tools config hardening",
);

console.log("tool-service internal tools config contract tests passed");
