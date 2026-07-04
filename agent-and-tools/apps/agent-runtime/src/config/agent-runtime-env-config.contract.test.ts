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
        "env.POLL_WORKER_INITIAL_DELAY_SEC,",
        "env.POLL_WORKER_GIT_NETWORK_TIMEOUT_SEC,",
        "env.POLL_WORKER_GIT_LOCAL_TIMEOUT_SEC,",
        "env.CAPABILITY_LEARNING_RUN_STALE_MS,",
        "env.CAPABILITY_DEFAULT_DAILY_TOKENS,",
        "env.CAPABILITY_DEFAULT_DAILY_COST_USD,",
        "env.CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE,",
        "env.AGENT_GOVERNANCE_LIMITS_TIMEOUT_SEC,",
        "env.AGENT_SOURCE_FETCH_TIMEOUT_SEC,",
        "env.CAPABILITY_DISCOVERY_FETCH_TIMEOUT_SEC,",
        "env.AGENT_CONTRACT_MINT_TIMEOUT_SEC,",
        "env.IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_SEC",
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
assert.match(defaults.stdout, /30:5:60:30:900000:200000:2:30:5:5:30:15:10/);

const custom = runEnv({
  POLL_WORKER_TICK_SEC: "60",
  POLL_WORKER_INITIAL_DELAY_SEC: "10",
  POLL_WORKER_GIT_NETWORK_TIMEOUT_SEC: "120",
  POLL_WORKER_GIT_LOCAL_TIMEOUT_SEC: "45",
  CAPABILITY_LEARNING_RUN_STALE_MS: "120000",
  CAPABILITY_DEFAULT_DAILY_TOKENS: "500000",
  CAPABILITY_DEFAULT_DAILY_COST_USD: "12.5",
  CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE: "90",
  AGENT_GOVERNANCE_LIMITS_TIMEOUT_SEC: "18",
  AGENT_SOURCE_FETCH_TIMEOUT_SEC: "12",
  CAPABILITY_DISCOVERY_FETCH_TIMEOUT_SEC: "45",
  AGENT_CONTRACT_MINT_TIMEOUT_SEC: "20",
  IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_SEC: "25",
});
assert.equal(custom.status, 0, custom.stderr);
assert.match(custom.stdout, /60:10:120:45:120000:500000:12\.5:90:18:12:45:20:25/);

for (const [name, value] of [
  ["POLL_WORKER_TICK_SEC", "4"],
  ["POLL_WORKER_INITIAL_DELAY_SEC", "0"],
  ["POLL_WORKER_GIT_NETWORK_TIMEOUT_SEC", "0"],
  ["POLL_WORKER_GIT_LOCAL_TIMEOUT_SEC", "0"],
  ["CAPABILITY_LEARNING_RUN_STALE_MS", "999"],
  ["CAPABILITY_DEFAULT_DAILY_TOKENS", "0"],
  ["CAPABILITY_DEFAULT_DAILY_COST_USD", "-1"],
  ["CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE", "0"],
  ["AGENT_GOVERNANCE_LIMITS_TIMEOUT_SEC", "0"],
  ["AGENT_SOURCE_FETCH_TIMEOUT_SEC", "0"],
  ["CAPABILITY_DISCOVERY_FETCH_TIMEOUT_SEC", "0"],
  ["AGENT_CONTRACT_MINT_TIMEOUT_SEC", "0"],
  ["IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_SEC", "0"],
] as const) {
  const result = runEnv({ [name]: value });
  assert.notEqual(result.status, 0, `${name}=${value} should be rejected`);
  assert.match(result.stderr, new RegExp(name));
}

const envSource = read("src/config/env.ts");
assert.match(envSource, /POLL_WORKER_TICK_SEC: boundedInt\(30, 5, AGENT_RUNTIME_LIMITS\.POLL_WORKER_TICK_SEC\)/);
assert.match(envSource, /POLL_WORKER_INITIAL_DELAY_SEC: boundedInt\(5, 1, AGENT_RUNTIME_LIMITS\.POLL_WORKER_INITIAL_DELAY_SEC\)/);
assert.match(envSource, /POLL_WORKER_GIT_NETWORK_TIMEOUT_SEC: boundedInt\([\s\S]*?60,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.POLL_WORKER_GIT_NETWORK_TIMEOUT_SEC/);
assert.match(envSource, /POLL_WORKER_GIT_LOCAL_TIMEOUT_SEC: boundedInt\([\s\S]*?30,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.POLL_WORKER_GIT_LOCAL_TIMEOUT_SEC/);
assert.match(envSource, /CAPABILITY_LEARNING_RUN_STALE_MS: boundedInt\([\s\S]*?15 \* 60 \* 1000,[\s\S]*?60_000,[\s\S]*?AGENT_RUNTIME_LIMITS\.CAPABILITY_LEARNING_RUN_STALE_MS/);
assert.match(envSource, /CAPABILITY_DEFAULT_DAILY_TOKENS: boundedInt\([\s\S]*?200_000,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.CAPABILITY_DEFAULT_DAILY_TOKENS/);
assert.match(envSource, /CAPABILITY_DEFAULT_DAILY_COST_USD: boundedNumber\([\s\S]*?2,[\s\S]*?0,[\s\S]*?AGENT_RUNTIME_LIMITS\.CAPABILITY_DEFAULT_DAILY_COST_USD/);
assert.match(envSource, /CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE: boundedInt\([\s\S]*?30,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE/);
assert.match(envSource, /AGENT_GOVERNANCE_LIMITS_TIMEOUT_SEC: boundedInt\([\s\S]*?5,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.AGENT_GOVERNANCE_LIMITS_TIMEOUT_SEC/);
assert.match(envSource, /AGENT_SOURCE_FETCH_TIMEOUT_SEC: boundedInt\([\s\S]*?5,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.AGENT_SOURCE_FETCH_TIMEOUT_SEC/);
assert.match(envSource, /CAPABILITY_DISCOVERY_FETCH_TIMEOUT_SEC: boundedInt\([\s\S]*?30,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.CAPABILITY_DISCOVERY_FETCH_TIMEOUT_SEC/);
assert.match(envSource, /AGENT_CONTRACT_MINT_TIMEOUT_SEC: boundedInt\([\s\S]*?15,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.AGENT_CONTRACT_MINT_TIMEOUT_SEC/);
assert.match(envSource, /IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_SEC: boundedInt\([\s\S]*?10,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_SEC/);

const capabilityService = read("src/modules/capabilities/capability.service.ts");
assert.match(capabilityService, /const CAPABILITY_LEARNING_RUN_STALE_MS = env\.CAPABILITY_LEARNING_RUN_STALE_MS;/);
assert.match(capabilityService, /const CAPABILITY_DISCOVERY_FETCH_TIMEOUT_MS = env\.CAPABILITY_DISCOVERY_FETCH_TIMEOUT_SEC \* 1000;/);
assert.match(capabilityService, /const tokensMax = env\.CAPABILITY_DEFAULT_DAILY_TOKENS;/);
assert.match(capabilityService, /const costMaxUsd = env\.CAPABILITY_DEFAULT_DAILY_COST_USD;/);
assert.match(capabilityService, /const maxCalls = env\.CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE;/);
assert.match(capabilityService, /const AGENT_GOVERNANCE_LIMITS_TIMEOUT_MS = env\.AGENT_GOVERNANCE_LIMITS_TIMEOUT_SEC \* 1000;/);
assert.doesNotMatch(capabilityService, /Number\(process\.env\.CAPABILITY_LEARNING_RUN_STALE_MS/);
assert.doesNotMatch(capabilityService, /Number\(process\.env\.CAPABILITY_DEFAULT_DAILY_TOKENS/);
assert.doesNotMatch(capabilityService, /Number\(process\.env\.CAPABILITY_DEFAULT_DAILY_COST_USD/);
assert.doesNotMatch(capabilityService, /Number\(process\.env\.CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE/);
assert.doesNotMatch(capabilityService, /Number\(process\.env\.AGENT_GOVERNANCE_LIMITS_TIMEOUT_SEC/);
assert.match(capabilityService, /AbortSignal\.timeout\(CAPABILITY_DISCOVERY_FETCH_TIMEOUT_MS\)/);
assert.match(capabilityService, /AbortSignal\.timeout\(AGENT_GOVERNANCE_LIMITS_TIMEOUT_MS\)/);
assert.doesNotMatch(capabilityService, /AbortSignal\.timeout\(30_000\)/);
assert.doesNotMatch(capabilityService, /AbortSignal\.timeout\(5_000\)/);

const pollWorker = read("src/modules/capabilities/poll-worker.ts");
assert.match(pollWorker, /const TICK_SEC\s+= env\.POLL_WORKER_TICK_SEC;/);
assert.match(pollWorker, /const INITIAL_DELAY_MS = env\.POLL_WORKER_INITIAL_DELAY_SEC \* 1000;/);
assert.match(pollWorker, /const GIT_NETWORK_TIMEOUT_MS = env\.POLL_WORKER_GIT_NETWORK_TIMEOUT_SEC \* 1000;/);
assert.match(pollWorker, /const GIT_LOCAL_TIMEOUT_MS = env\.POLL_WORKER_GIT_LOCAL_TIMEOUT_SEC \* 1000;/);
assert.match(pollWorker, /timeout: GIT_NETWORK_TIMEOUT_MS/);
assert.match(pollWorker, /timeout: GIT_LOCAL_TIMEOUT_MS/);
assert.doesNotMatch(pollWorker, /Number\(process\.env\.POLL_WORKER_TICK_SEC/);
assert.doesNotMatch(pollWorker, /setTimeout\(\(\) => \{ void tick\(\); \}, 5_000\)/);
assert.doesNotMatch(pollWorker, /timeout: (?:60_000|30_000)/);

const agentService = read("src/modules/agents/agent.service.ts");
assert.match(agentService, /const AGENT_SOURCE_FETCH_TIMEOUT_MS = env\.AGENT_SOURCE_FETCH_TIMEOUT_SEC \* 1000;/);
assert.match(agentService, /const AGENT_CONTRACT_MINT_TIMEOUT_MS = env\.AGENT_CONTRACT_MINT_TIMEOUT_SEC \* 1000;/);
assert.match(agentService, /AbortSignal\.timeout\(AGENT_SOURCE_FETCH_TIMEOUT_MS\)/);
assert.doesNotMatch(agentService, /AbortSignal\.timeout\(5_000\)/);
assert.match(agentService, /AbortSignal\.timeout\(AGENT_CONTRACT_MINT_TIMEOUT_MS\)/);
assert.doesNotMatch(agentService, /AbortSignal\.timeout\(15_000\)/);

const iamServiceToken = read("src/lib/iam/service-token.ts");
assert.match(iamServiceToken, /const IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_MS = env\.IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_SEC \* 1000;/);
assert.match(iamServiceToken, /AbortSignal\.timeout\(IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_MS\)/);
assert.doesNotMatch(iamServiceToken, /AbortSignal\.timeout\(10_000\)/);

console.log("agent-runtime env config contract tests passed");
