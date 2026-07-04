import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boundedIntEnv } from "../shared/env-bounds";

const originalEnv = { ...process.env };

try {
  process.env.CONTEXT_FABRIC_CLIENT_TIMEOUT_SEC = "bad";
  assert.equal(boundedIntEnv("CONTEXT_FABRIC_CLIENT_TIMEOUT_SEC", 240, 1, 900), 240);

  process.env.CONTEXT_FABRIC_CLIENT_TIMEOUT_SEC = "0";
  assert.equal(boundedIntEnv("CONTEXT_FABRIC_CLIENT_TIMEOUT_SEC", 240, 1, 900), 240);

  process.env.CONTEXT_FABRIC_CLIENT_TIMEOUT_SEC = "12.9";
  assert.equal(boundedIntEnv("CONTEXT_FABRIC_CLIENT_TIMEOUT_SEC", 240, 1, 900), 12);

  process.env.CONTEXT_FABRIC_CLIENT_TIMEOUT_SEC = "9999";
  assert.equal(boundedIntEnv("CONTEXT_FABRIC_CLIENT_TIMEOUT_SEC", 240, 1, 900), 900);
} finally {
  process.env = originalEnv;
}

const config = readFileSync("src/clients/context-fabric.config.ts", "utf8");
const client = readFileSync("src/clients/context-fabric.client.ts", "utf8");
const pkg = readFileSync("package.json", "utf8");

assert.match(
  config,
  /boundedIntEnv\("CONTEXT_FABRIC_CLIENT_TIMEOUT_SEC", 240, 1, 900\)/,
  "Context Fabric client timeout must be bounded at 1..900 seconds",
);
assert.match(
  client,
  /config: contextFabricClientConfig\(\)/,
  "Context Fabric client must expose bounded config",
);
assert.match(
  client,
  /AbortSignal\.timeout\(contextFabricClient\.config\.timeoutMs\)/,
  "Context Fabric client fetches must use bounded timeout config",
);
assert.doesNotMatch(
  client,
  /AbortSignal\.timeout\(240_000\)/,
  "Context Fabric client must not hardcode four-minute fetch timeouts",
);
assert.match(
  pkg,
  /context-fabric-config\.contract\.test\.ts/,
  "contract suite must include Context Fabric client config hardening",
);

console.log("prompt-composer Context Fabric client config contract tests passed");
