import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { boundedInteger } from "../lib/env";

const connectorToolsSource = readFileSync(path.resolve(__dirname, "connector-tools.ts"), "utf8");
const packageSource = readFileSync(path.resolve(process.cwd(), "package.json"), "utf8");

assert.equal(boundedInteger(undefined, { defaultValue: 15_000, min: 1_000, max: 300_000 }), 15_000);
assert.equal(boundedInteger("", { defaultValue: 15_000, min: 1_000, max: 300_000 }), 15_000);
assert.equal(boundedInteger("bad", { defaultValue: 15_000, min: 1_000, max: 300_000 }), 15_000);
assert.equal(boundedInteger("999", { defaultValue: 15_000, min: 1_000, max: 300_000 }), 15_000);
assert.equal(boundedInteger("1200.9", { defaultValue: 15_000, min: 1_000, max: 300_000 }), 1200);
assert.equal(boundedInteger("999999999", { defaultValue: 15_000, min: 1_000, max: 300_000 }), 300_000);

assert.match(
  connectorToolsSource,
  /boundedEnvInteger\("WORKGRAPH_CONNECTOR_LIST_TIMEOUT_MS"[\s\S]*?defaultValue: 15_000[\s\S]*?min: 1_000[\s\S]*?max: 300_000/,
  "connector list timeout must use bounded env parsing",
);
assert.match(
  connectorToolsSource,
  /boundedEnvInteger\("WORKGRAPH_CONNECTOR_INVOKE_TIMEOUT_MS"[\s\S]*?defaultValue: 60_000[\s\S]*?min: 1_000[\s\S]*?max: 300_000/,
  "connector invoke timeout must use bounded env parsing",
);
assert.match(
  connectorToolsSource,
  /AbortSignal\.timeout\(WORKGRAPH_CONNECTOR_LIST_TIMEOUT_MS\)/,
  "connector list fetches must use the bounded timeout constant",
);
assert.match(
  connectorToolsSource,
  /AbortSignal\.timeout\(WORKGRAPH_CONNECTOR_INVOKE_TIMEOUT_MS\)/,
  "connector invoke fetches must use the bounded timeout constant",
);
assert.doesNotMatch(
  connectorToolsSource,
  /AbortSignal\.timeout\((?:15_000|60_000)\)/,
  "connector tool fetches must not hardcode timeouts",
);
assert.doesNotMatch(
  connectorToolsSource,
  /Number\(process\.env\.WORKGRAPH_CONNECTOR_/,
  "connector tool timeouts must not parse env vars directly",
);
assert.match(
  packageSource,
  /connector-tools-config\.contract\.test\.ts/,
  "agent-service contract suite must include connector tools timeout hardening",
);

console.log("tool-service connector tools config contract tests passed");
