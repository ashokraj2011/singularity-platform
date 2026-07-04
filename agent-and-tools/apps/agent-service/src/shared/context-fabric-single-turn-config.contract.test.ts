import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { boundedInteger } from "./env";

const configSource = readFileSync(path.resolve(process.cwd(), "src/shared/context-fabric-single-turn.config.ts"), "utf8");
const runtimeSource = readFileSync(path.resolve(process.cwd(), "src/routes/runtime.ts"), "utf8");
const internalToolsSource = readFileSync(path.resolve(process.cwd(), "src/tool/routes/internal-tools.ts"), "utf8");
const toolEnvSource = readFileSync(path.resolve(process.cwd(), "src/tool/lib/env.ts"), "utf8");
const packageSource = readFileSync(path.resolve(process.cwd(), "package.json"), "utf8");

assert.equal(boundedInteger(undefined, { defaultValue: 70, min: 1, max: 300 }), 70);
assert.equal(boundedInteger("", { defaultValue: 70, min: 1, max: 300 }), 70);
assert.equal(boundedInteger("bad", { defaultValue: 70, min: 1, max: 300 }), 70);
assert.equal(boundedInteger("0", { defaultValue: 70, min: 1, max: 300 }), 70);
assert.equal(boundedInteger("12.9", { defaultValue: 70, min: 1, max: 300 }), 12);
assert.equal(boundedInteger("99999", { defaultValue: 70, min: 1, max: 300 }), 300);

assert.match(
  configSource,
  /boundedEnvInteger\("CONTEXT_FABRIC_SINGLE_TURN_TIMEOUT_SEC"/,
  "Context Fabric single-turn timeout must use bounded env parsing",
);
assert.match(configSource, /defaultValue:\s*70/);
assert.match(configSource, /min:\s*1/);
assert.match(configSource, /max:\s*300/);

for (const [name, source] of [
  ["agent runtime distillation", runtimeSource],
  ["tool internal synthesis", internalToolsSource],
] as const) {
  assert.match(
    source,
    /const CONTEXT_FABRIC_SINGLE_TURN_CONFIG = contextFabricSingleTurnConfig\(\);/,
    `${name} must read shared Context Fabric single-turn timeout config`,
  );
  assert.match(
    source,
    /timeoutSec: CONTEXT_FABRIC_SINGLE_TURN_CONFIG\.timeoutSec/,
    `${name} must pass bounded timeout seconds to Context Fabric limits`,
  );
  assert.match(
    source,
    /AbortSignal\.timeout\(CONTEXT_FABRIC_SINGLE_TURN_CONFIG\.timeoutMs\)/,
    `${name} must use bounded timeout milliseconds for fetch cancellation`,
  );
  assert.doesNotMatch(source, /timeoutSec:\s*70/);
  assert.doesNotMatch(source, /AbortSignal\.timeout\(70_000\)/);
}

assert.match(
  toolEnvSource,
  /from "\.\.\/\.\.\/shared\/env"/,
  "tool env helper should re-export the shared bounded env helper",
);
assert.match(
  packageSource,
  /context-fabric-single-turn-config\.contract\.test\.ts/,
  "agent-service contract suite must include Context Fabric timeout config hardening",
);

console.log("agent-service Context Fabric single-turn config contract tests passed");
