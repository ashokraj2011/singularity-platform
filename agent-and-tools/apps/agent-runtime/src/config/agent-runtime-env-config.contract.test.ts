import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE_ENV = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:singularity@localhost:5432/singularity",
  JWT_SECRET: "test-secret-min-32-chars-for-contracts",
  AUTH_OPTIONAL: "true",
};

function runEnv(extraEnv: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      "-e",
      [
        "const { env } = require('./src/config/env');",
        "console.log([",
        "env.POLL_WORKER_TICK_SEC,",
        "env.CAPABILITY_LEARNING_RUN_STALE_MS,",
        "env.CAPABILITY_DEFAULT_DAILY_TOKENS,",
        "env.CAPABILITY_DEFAULT_DAILY_COST_USD,",
        "env.CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE",
        "].join(':'));",
      ].join(" "),
    ],
    {
      cwd: process.cwd(),
      env: { ...BASE_ENV, ...extraEnv },
      encoding: "utf8",
    },
  );
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const defaults = runEnv({});
assert.equal(defaults.status, 0, defaults.stderr);
assert.match(defaults.stdout, /30:900000:200000:2:30/);

const custom = runEnv({
  POLL_WORKER_TICK_SEC: "60",
  CAPABILITY_LEARNING_RUN_STALE_MS: "120000",
  CAPABILITY_DEFAULT_DAILY_TOKENS: "500000",
  CAPABILITY_DEFAULT_DAILY_COST_USD: "12.5",
  CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE: "90",
});
assert.equal(custom.status, 0, custom.stderr);
assert.match(custom.stdout, /60:120000:500000:12\.5:90/);

for (const [name, value] of [
  ["POLL_WORKER_TICK_SEC", "4"],
  ["CAPABILITY_LEARNING_RUN_STALE_MS", "999"],
  ["CAPABILITY_DEFAULT_DAILY_TOKENS", "0"],
  ["CAPABILITY_DEFAULT_DAILY_COST_USD", "-1"],
  ["CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE", "0"],
] as const) {
  const result = runEnv({ [name]: value });
  assert.notEqual(result.status, 0, `${name}=${value} should be rejected`);
  assert.match(result.stderr, new RegExp(name));
}

const envSource = read("src/config/env.ts");
assert.match(envSource, /POLL_WORKER_TICK_SEC: boundedInt\(30, 5, AGENT_RUNTIME_LIMITS\.POLL_WORKER_TICK_SEC\)/);
assert.match(envSource, /CAPABILITY_LEARNING_RUN_STALE_MS: boundedInt\([\s\S]*?15 \* 60 \* 1000,[\s\S]*?60_000,[\s\S]*?AGENT_RUNTIME_LIMITS\.CAPABILITY_LEARNING_RUN_STALE_MS/);
assert.match(envSource, /CAPABILITY_DEFAULT_DAILY_TOKENS: boundedInt\([\s\S]*?200_000,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.CAPABILITY_DEFAULT_DAILY_TOKENS/);
assert.match(envSource, /CAPABILITY_DEFAULT_DAILY_COST_USD: boundedNumber\([\s\S]*?2,[\s\S]*?0,[\s\S]*?AGENT_RUNTIME_LIMITS\.CAPABILITY_DEFAULT_DAILY_COST_USD/);
assert.match(envSource, /CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE: boundedInt\([\s\S]*?30,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE/);

const capabilityService = read("src/modules/capabilities/capability.service.ts");
assert.match(capabilityService, /const CAPABILITY_LEARNING_RUN_STALE_MS = env\.CAPABILITY_LEARNING_RUN_STALE_MS;/);
assert.match(capabilityService, /const tokensMax = env\.CAPABILITY_DEFAULT_DAILY_TOKENS;/);
assert.match(capabilityService, /const costMaxUsd = env\.CAPABILITY_DEFAULT_DAILY_COST_USD;/);
assert.match(capabilityService, /const maxCalls = env\.CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE;/);
assert.doesNotMatch(capabilityService, /Number\(process\.env\.CAPABILITY_LEARNING_RUN_STALE_MS/);
assert.doesNotMatch(capabilityService, /Number\(process\.env\.CAPABILITY_DEFAULT_DAILY_TOKENS/);
assert.doesNotMatch(capabilityService, /Number\(process\.env\.CAPABILITY_DEFAULT_DAILY_COST_USD/);
assert.doesNotMatch(capabilityService, /Number\(process\.env\.CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE/);

const pollWorker = read("src/modules/capabilities/poll-worker.ts");
assert.match(pollWorker, /const TICK_SEC\s+= env\.POLL_WORKER_TICK_SEC;/);
assert.doesNotMatch(pollWorker, /Number\(process\.env\.POLL_WORKER_TICK_SEC/);

console.log("agent-runtime env config contract tests passed");
