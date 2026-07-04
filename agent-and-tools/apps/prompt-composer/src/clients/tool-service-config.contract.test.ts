import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function runEnv(extraEnv: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      "-e",
      [
        "const { env } = require('./src/config/env');",
        "console.log(env.TOOL_SERVICE_DISCOVERY_TIMEOUT_SEC);",
      ].join(" "),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test",
        JWT_SECRET: "test-secret-min-32-chars-for-contracts",
        AUTH_OPTIONAL: "true",
        ...extraEnv,
      },
      encoding: "utf8",
    },
  );
}

const defaultEnv = runEnv({});
assert.equal(defaultEnv.status, 0, defaultEnv.stderr);
assert.match(defaultEnv.stdout, /^5\s*$/);

const fallbackEnv = runEnv({ TOOL_SERVICE_DISCOVERY_TIMEOUT_SEC: "0" });
assert.equal(fallbackEnv.status, 0, fallbackEnv.stderr);
assert.match(fallbackEnv.stdout, /^5\s*$/);

const boundedEnv = runEnv({ TOOL_SERVICE_DISCOVERY_TIMEOUT_SEC: "9999" });
assert.equal(boundedEnv.status, 0, boundedEnv.stderr);
assert.match(boundedEnv.stdout, /^300\s*$/);

const envSource = readFileSync("src/config/env.ts", "utf8");
const clientSource = readFileSync("src/clients/tool-service.client.ts", "utf8");
const pkg = readFileSync("package.json", "utf8");

assert.match(
  envSource,
  /TOOL_SERVICE_DISCOVERY_TIMEOUT_SEC: boundedInt\(5, 1, 300\)/,
  "tool-service discovery timeout must be bounded in prompt-composer env config",
);
assert.match(
  clientSource,
  /const TOOL_SERVICE_DISCOVERY_TIMEOUT_MS = env\.TOOL_SERVICE_DISCOVERY_TIMEOUT_SEC \* 1000;/,
  "tool-service discovery timeout must come from bounded env config",
);
assert.match(
  clientSource,
  /\/api\/v1\/tools\/discover[\s\S]*?signal: AbortSignal\.timeout\(TOOL_SERVICE_DISCOVERY_TIMEOUT_MS\)/,
  "tool-service discovery fetch must use the bounded timeout",
);
assert.doesNotMatch(
  clientSource,
  /AbortSignal\.timeout\((?:5_000|5000)\)/,
  "tool-service discovery fetch must not hardcode its timeout",
);
assert.match(
  pkg,
  /tool-service-config\.contract\.test\.ts/,
  "contract suite must include tool-service discovery timeout hardening",
);

console.log("prompt-composer tool-service config contract tests passed");
