import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE_ENV = {
  ...process.env,
  NODE_ENV: "test",
  MCP_BEARER_TOKEN: "test-bearer-token-12345",
  LLM_GATEWAY_URL: "mock",
};

function runConfig(extraEnv: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      "-e",
      [
        "const { config } = require('./src/config');",
        "console.log([",
        "config.MCP_LOOP_REPETITION_THRESHOLD,",
        "config.MCP_LOOP_REPETITION_WINDOW,",
        "config.SYSTEM_PROMPT_CACHE_TTL_SEC,",
        "config.MCP_PROMPT_COMPOSER_TIMEOUT_SEC,",
        "config.MCP_AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_SEC,",
        "config.MCP_LEARNING_SERVICE_TIMEOUT_SEC,",
        "config.MCP_WORKSPACE_BRANCH_PROBE_TIMEOUT_MS,",
        "config.MCP_RUNNER_EXECUTE_GRACE_MS,",
        "config.MCP_RUNNER_HEALTH_TIMEOUT_MS,",
        "config.MCP_STRICT_HEALTH_GIT_TIMEOUT_MS,",
        "config.MCP_STRICT_HEALTH_LLM_TIMEOUT_MS,",
        "config.MCP_LLM_PROVIDER_STATUS_TIMEOUT_MS,",
        "config.MCP_AUDIT_GOV_CHECK_TIMEOUT_MS,",
        "config.MCP_AUDIT_GOV_EMIT_TIMEOUT_MS,",
        "config.MCP_AUDIT_GOV_APPROVAL_TIMEOUT_MS,",
        "config.MCP_RUNTIME_BRIDGE_HEARTBEAT_MS,",
        "config.MCP_RUNTIME_BRIDGE_HANDSHAKE_TIMEOUT_MS,",
        "config.MCP_RUNTIME_BRIDGE_RECONNECT_MIN_BACKOFF_MS,",
        "config.MCP_RUNTIME_BRIDGE_RECONNECT_MAX_BACKOFF_MS,",
        "config.MCP_WORKTREE_GIT_HASH_TIMEOUT_MS,",
        "config.MCP_WORKTREE_GIT_WRITE_TIMEOUT_MS,",
        "config.MCP_SOURCE_DISCOVERY_TIMEOUT_MS,",
        "config.MCP_HTTP_TOOL_TIMEOUT_MS,",
        "config.MCP_GIT_HISTORY_TIMEOUT_MS,",
        "config.MCP_PROCESS_KILL_GRACE_MS,",
        "config.MCP_MUTATION_FINALIZATION_MAX_TOKENS,",
        "config.MCP_PII_NER_CONFIDENCE_FLOOR",
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

const defaults = runConfig({});
assert.equal(defaults.status, 0, defaults.stderr);
assert.match(defaults.stdout, /3:5:300:5:5:8:2000:5000:1500:2000:1500:2000:3000:5000:5000:30000:10000:1000:60000:5000:30000:20000:30000:60000:2000:4096:0\.7/);

const custom = runConfig({
  MCP_LOOP_REPETITION_THRESHOLD: "4",
  MCP_LOOP_REPETITION_WINDOW: "9",
  SYSTEM_PROMPT_CACHE_TTL_SEC: "120",
  MCP_PROMPT_COMPOSER_TIMEOUT_SEC: "9",
  MCP_AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_SEC: "12",
  MCP_LEARNING_SERVICE_TIMEOUT_SEC: "11",
  MCP_WORKSPACE_BRANCH_PROBE_TIMEOUT_MS: "2500",
  MCP_RUNNER_EXECUTE_GRACE_MS: "6000",
  MCP_RUNNER_HEALTH_TIMEOUT_MS: "2500",
  MCP_STRICT_HEALTH_GIT_TIMEOUT_MS: "3000",
  MCP_STRICT_HEALTH_LLM_TIMEOUT_MS: "3500",
  MCP_LLM_PROVIDER_STATUS_TIMEOUT_MS: "4500",
  MCP_AUDIT_GOV_CHECK_TIMEOUT_MS: "4000",
  MCP_AUDIT_GOV_EMIT_TIMEOUT_MS: "4500",
  MCP_AUDIT_GOV_APPROVAL_TIMEOUT_MS: "5500",
  MCP_RUNTIME_BRIDGE_HEARTBEAT_MS: "45000",
  MCP_RUNTIME_BRIDGE_HANDSHAKE_TIMEOUT_MS: "15000",
  MCP_RUNTIME_BRIDGE_RECONNECT_MIN_BACKOFF_MS: "2000",
  MCP_RUNTIME_BRIDGE_RECONNECT_MAX_BACKOFF_MS: "90000",
  MCP_WORKTREE_GIT_HASH_TIMEOUT_MS: "6500",
  MCP_WORKTREE_GIT_WRITE_TIMEOUT_MS: "35000",
  MCP_SOURCE_DISCOVERY_TIMEOUT_MS: "25000",
  MCP_HTTP_TOOL_TIMEOUT_MS: "33000",
  MCP_GIT_HISTORY_TIMEOUT_MS: "65000",
  MCP_PROCESS_KILL_GRACE_MS: "3500",
  MCP_MUTATION_FINALIZATION_MAX_TOKENS: "8192",
  MCP_PII_NER_CONFIDENCE_FLOOR: "0.85",
});
assert.equal(custom.status, 0, custom.stderr);
assert.match(custom.stdout, /4:9:120:9:12:11:2500:6000:2500:3000:3500:4500:4000:4500:5500:45000:15000:2000:90000:6500:35000:25000:33000:65000:3500:8192:0\.85/);

const impossibleLoopDetector = runConfig({
  MCP_LOOP_REPETITION_THRESHOLD: "10",
  MCP_LOOP_REPETITION_WINDOW: "3",
});
assert.notEqual(impossibleLoopDetector.status, 0);
assert.match(impossibleLoopDetector.stderr, /MCP_LOOP_REPETITION_THRESHOLD/);

const invertedRuntimeBridgeBackoff = runConfig({
  MCP_RUNTIME_BRIDGE_RECONNECT_MIN_BACKOFF_MS: "3000",
  MCP_RUNTIME_BRIDGE_RECONNECT_MAX_BACKOFF_MS: "2000",
});
assert.notEqual(invertedRuntimeBridgeBackoff.status, 0);
assert.match(invertedRuntimeBridgeBackoff.stderr, /MCP_RUNTIME_BRIDGE_RECONNECT_MIN_BACKOFF_MS/);

for (const [name, value] of [
  ["MCP_LOOP_REPETITION_THRESHOLD", "0"],
  ["MCP_LOOP_REPETITION_WINDOW", "101"],
  ["SYSTEM_PROMPT_CACHE_TTL_SEC", "999999"],
  ["MCP_PROMPT_COMPOSER_TIMEOUT_SEC", "0"],
  ["MCP_AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_SEC", "0"],
  ["MCP_LEARNING_SERVICE_TIMEOUT_SEC", "0"],
  ["MCP_WORKSPACE_BRANCH_PROBE_TIMEOUT_MS", "0"],
  ["MCP_RUNNER_EXECUTE_GRACE_MS", "0"],
  ["MCP_RUNNER_HEALTH_TIMEOUT_MS", "0"],
  ["MCP_STRICT_HEALTH_GIT_TIMEOUT_MS", "0"],
  ["MCP_STRICT_HEALTH_LLM_TIMEOUT_MS", "0"],
  ["MCP_LLM_PROVIDER_STATUS_TIMEOUT_MS", "0"],
  ["MCP_AUDIT_GOV_CHECK_TIMEOUT_MS", "0"],
  ["MCP_AUDIT_GOV_EMIT_TIMEOUT_MS", "0"],
  ["MCP_AUDIT_GOV_APPROVAL_TIMEOUT_MS", "0"],
  ["MCP_RUNTIME_BRIDGE_HEARTBEAT_MS", "0"],
  ["MCP_RUNTIME_BRIDGE_HANDSHAKE_TIMEOUT_MS", "0"],
  ["MCP_RUNTIME_BRIDGE_RECONNECT_MIN_BACKOFF_MS", "0"],
  ["MCP_RUNTIME_BRIDGE_RECONNECT_MAX_BACKOFF_MS", "0"],
  ["MCP_WORKTREE_GIT_HASH_TIMEOUT_MS", "0"],
  ["MCP_WORKTREE_GIT_WRITE_TIMEOUT_MS", "0"],
  ["MCP_SOURCE_DISCOVERY_TIMEOUT_MS", "0"],
  ["MCP_HTTP_TOOL_TIMEOUT_MS", "0"],
  ["MCP_GIT_HISTORY_TIMEOUT_MS", "0"],
  ["MCP_PROCESS_KILL_GRACE_MS", "0"],
  ["MCP_MUTATION_FINALIZATION_MAX_TOKENS", "999999"],
  ["MCP_PII_NER_CONFIDENCE_FLOOR", "1.1"],
] as const) {
  const result = runConfig({ [name]: value });
  assert.notEqual(result.status, 0, `${name}=${value} should be rejected`);
  assert.match(result.stderr, new RegExp(name));
}

const configSource = readFileSync("src/config.ts", "utf8");
assert.match(configSource, /MCP_LOOP_REPETITION_THRESHOLD: boundedPositiveInt\(3, MCP_LIMITS\.LOOP_REPETITION_THRESHOLD\)/);
assert.match(configSource, /MCP_LOOP_REPETITION_WINDOW: boundedPositiveInt\(5, MCP_LIMITS\.LOOP_REPETITION_WINDOW\)/);
assert.match(configSource, /SYSTEM_PROMPT_CACHE_TTL_SEC: boundedPositiveInt\(300, MCP_LIMITS\.SYSTEM_PROMPT_CACHE_TTL_SEC\)/);
assert.match(configSource, /MCP_PROMPT_COMPOSER_TIMEOUT_SEC: boundedPositiveInt\(5, MCP_LIMITS\.PROMPT_COMPOSER_TIMEOUT_SEC\)/);
assert.match(configSource, /MCP_AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_SEC: boundedPositiveInt\([\s\S]*?5,[\s\S]*?MCP_LIMITS\.AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_SEC/);
assert.match(configSource, /MCP_LEARNING_SERVICE_TIMEOUT_SEC: boundedPositiveInt\(8, MCP_LIMITS\.LEARNING_SERVICE_TIMEOUT_SEC\)/);
assert.match(configSource, /MCP_WORKSPACE_BRANCH_PROBE_TIMEOUT_MS: boundedPositiveInt\(2_000, MCP_LIMITS\.WORKSPACE_BRANCH_PROBE_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_RUNNER_EXECUTE_GRACE_MS: boundedPositiveInt\(5_000, MCP_LIMITS\.RUNNER_EXECUTE_GRACE_MS\)/);
assert.match(configSource, /MCP_RUNNER_HEALTH_TIMEOUT_MS: boundedPositiveInt\(1_500, MCP_LIMITS\.RUNNER_HEALTH_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_STRICT_HEALTH_GIT_TIMEOUT_MS: boundedPositiveInt\(2_000, MCP_LIMITS\.STRICT_HEALTH_GIT_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_STRICT_HEALTH_LLM_TIMEOUT_MS: boundedPositiveInt\(1_500, MCP_LIMITS\.STRICT_HEALTH_LLM_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_LLM_PROVIDER_STATUS_TIMEOUT_MS: boundedPositiveInt\(2_000, MCP_LIMITS\.LLM_PROVIDER_STATUS_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_AUDIT_GOV_CHECK_TIMEOUT_MS: boundedPositiveInt\(3_000, MCP_LIMITS\.AUDIT_GOV_CHECK_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_AUDIT_GOV_EMIT_TIMEOUT_MS: boundedPositiveInt\(5_000, MCP_LIMITS\.AUDIT_GOV_EMIT_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_AUDIT_GOV_APPROVAL_TIMEOUT_MS: boundedPositiveInt\(5_000, MCP_LIMITS\.AUDIT_GOV_APPROVAL_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_RUNTIME_BRIDGE_HEARTBEAT_MS: boundedPositiveInt\(30_000, MCP_LIMITS\.RUNTIME_BRIDGE_HEARTBEAT_MS\)/);
assert.match(configSource, /MCP_RUNTIME_BRIDGE_HANDSHAKE_TIMEOUT_MS: boundedPositiveInt\([\s\S]*?10_000,[\s\S]*?MCP_LIMITS\.RUNTIME_BRIDGE_HANDSHAKE_TIMEOUT_MS/);
assert.match(configSource, /MCP_RUNTIME_BRIDGE_RECONNECT_MIN_BACKOFF_MS: boundedPositiveInt\([\s\S]*?1_000,[\s\S]*?MCP_LIMITS\.RUNTIME_BRIDGE_RECONNECT_MIN_BACKOFF_MS/);
assert.match(configSource, /MCP_RUNTIME_BRIDGE_RECONNECT_MAX_BACKOFF_MS: boundedPositiveInt\([\s\S]*?60_000,[\s\S]*?MCP_LIMITS\.RUNTIME_BRIDGE_RECONNECT_MAX_BACKOFF_MS/);
assert.match(configSource, /MCP_RUNTIME_BRIDGE_RECONNECT_MIN_BACKOFF_MS must be less than or equal to[\s\S]*?MCP_RUNTIME_BRIDGE_RECONNECT_MAX_BACKOFF_MS/);
assert.match(configSource, /MCP_WORKTREE_GIT_HASH_TIMEOUT_MS: boundedPositiveInt\(5_000, MCP_LIMITS\.WORKTREE_GIT_HASH_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_WORKTREE_GIT_WRITE_TIMEOUT_MS: boundedPositiveInt\(30_000, MCP_LIMITS\.WORKTREE_GIT_WRITE_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_SOURCE_DISCOVERY_TIMEOUT_MS: boundedPositiveInt\(20_000, MCP_LIMITS\.SOURCE_DISCOVERY_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_HTTP_TOOL_TIMEOUT_MS: boundedPositiveInt\(30_000, MCP_LIMITS\.HTTP_TOOL_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_GIT_HISTORY_TIMEOUT_MS: boundedPositiveInt\(60_000, MCP_LIMITS\.GIT_HISTORY_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_PROCESS_KILL_GRACE_MS: boundedPositiveInt\(2_000, MCP_LIMITS\.PROCESS_KILL_GRACE_MS\)/);
assert.match(configSource, /MCP_MUTATION_FINALIZATION_MAX_TOKENS: boundedPositiveInt\(4096, MCP_LIMITS\.MUTATION_FINALIZATION_MAX_TOKENS\)/);
assert.match(configSource, /MCP_PII_NER_CONFIDENCE_FLOOR: boundedNumber\(0\.7, 0, 1\)/);

const invokeSource = readFileSync("src/mcp/invoke.ts", "utf8");
assert.match(invokeSource, /const LOOP_REPETITION_THRESHOLD = config\.MCP_LOOP_REPETITION_THRESHOLD;/);
assert.match(invokeSource, /const LOOP_REPETITION_WINDOW\s+= config\.MCP_LOOP_REPETITION_WINDOW;/);
assert.match(invokeSource, /const NUDGE_PROMPT_TTL_MS = config\.SYSTEM_PROMPT_CACHE_TTL_SEC \* 1000;/);
assert.match(invokeSource, /const PROMPT_COMPOSER_TIMEOUT_MS = config\.MCP_PROMPT_COMPOSER_TIMEOUT_SEC \* 1000;/);
assert.match(invokeSource, /config\.MCP_MUTATION_FINALIZATION_MAX_TOKENS/);
assert.doesNotMatch(invokeSource, /Number\(process\.env\.MCP_LOOP_REPETITION_THRESHOLD/);
assert.doesNotMatch(invokeSource, /Number\(process\.env\.MCP_LOOP_REPETITION_WINDOW/);
assert.doesNotMatch(invokeSource, /Number\(process\.env\.SYSTEM_PROMPT_CACHE_TTL_SEC/);
assert.doesNotMatch(invokeSource, /AbortSignal\.timeout\(5_000\)/);
assert.doesNotMatch(invokeSource, /Number\(process\.env\.MCP_MUTATION_FINALIZATION_MAX_TOKENS/);

const piiSource = readFileSync("src/security/pii-ner.ts", "utf8");
assert.match(piiSource, /const NER_CONFIDENCE_FLOOR = config\.MCP_PII_NER_CONFIDENCE_FLOOR;/);
assert.doesNotMatch(piiSource, /Number\(process\.env\.MCP_PII_NER_CONFIDENCE_FLOOR/);

const healthzSource = readFileSync("src/healthz-strict.ts", "utf8");
assert.match(healthzSource, /const STRICT_HEALTH_GIT_TIMEOUT_MS = config\.MCP_STRICT_HEALTH_GIT_TIMEOUT_MS;/);
assert.match(healthzSource, /const STRICT_HEALTH_LLM_TIMEOUT_MS = config\.MCP_STRICT_HEALTH_LLM_TIMEOUT_MS;/);
assert.match(healthzSource, /timeout: STRICT_HEALTH_GIT_TIMEOUT_MS/);
assert.match(healthzSource, /AbortSignal\.timeout\(STRICT_HEALTH_LLM_TIMEOUT_MS\)/);
assert.doesNotMatch(healthzSource, /timeout: 2000/);
assert.doesNotMatch(healthzSource, /AbortSignal\.timeout\(1500\)/);

const worktreeSource = readFileSync("src/mcp/worktree.ts", "utf8");
assert.match(worktreeSource, /const WORKTREE_GIT_HASH_TIMEOUT_MS = config\.MCP_WORKTREE_GIT_HASH_TIMEOUT_MS;/);
assert.match(worktreeSource, /const WORKTREE_GIT_WRITE_TIMEOUT_MS = config\.MCP_WORKTREE_GIT_WRITE_TIMEOUT_MS;/);
assert.match(worktreeSource, /timeout: WORKTREE_GIT_HASH_TIMEOUT_MS/);
assert.match(worktreeSource, /timeout: WORKTREE_GIT_WRITE_TIMEOUT_MS/);
assert.doesNotMatch(worktreeSource, /timeout: 5_000/);
assert.doesNotMatch(worktreeSource, /timeout: 30_000/);

const sourceDiscoverSource = readFileSync("src/mcp/source-discover.ts", "utf8");
assert.match(sourceDiscoverSource, /const SOURCE_DISCOVERY_TIMEOUT_MS = config\.MCP_SOURCE_DISCOVERY_TIMEOUT_MS;/);
assert.match(sourceDiscoverSource, /timeoutMs = SOURCE_DISCOVERY_TIMEOUT_MS/);
assert.doesNotMatch(sourceDiscoverSource, /timeoutMs = 20_000/);

const llmClientSource = readFileSync("src/llm/client.ts", "utf8");
assert.match(llmClientSource, /const LLM_PROVIDER_STATUS_TIMEOUT_MS = config\.MCP_LLM_PROVIDER_STATUS_TIMEOUT_MS;/);
assert.match(llmClientSource, /AbortSignal\.timeout\(LLM_PROVIDER_STATUS_TIMEOUT_MS\)/);
assert.doesNotMatch(llmClientSource, /AbortSignal\.timeout\(2000\)/);

const relayClientSource = readFileSync("src/laptop/relay-client.ts", "utf8");
assert.match(relayClientSource, /const HEARTBEAT_MS = config\.MCP_RUNTIME_BRIDGE_HEARTBEAT_MS;/);
assert.match(relayClientSource, /const RELAY_HANDSHAKE_TIMEOUT_MS = config\.MCP_RUNTIME_BRIDGE_HANDSHAKE_TIMEOUT_MS;/);
assert.match(relayClientSource, /const MIN_BACKOFF_MS = config\.MCP_RUNTIME_BRIDGE_RECONNECT_MIN_BACKOFF_MS;/);
assert.match(relayClientSource, /const MAX_BACKOFF_MS = config\.MCP_RUNTIME_BRIDGE_RECONNECT_MAX_BACKOFF_MS;/);
assert.match(relayClientSource, /handshakeTimeout: RELAY_HANDSHAKE_TIMEOUT_MS/);
assert.match(relayClientSource, /setInterval\(\(\) => \{[\s\S]*?\}, HEARTBEAT_MS\)/);
assert.doesNotMatch(relayClientSource, /const HEARTBEAT_MS = 30_000/);
assert.doesNotMatch(relayClientSource, /const MIN_BACKOFF_MS = 1_000/);
assert.doesNotMatch(relayClientSource, /const MAX_BACKOFF_MS = 60_000/);
assert.doesNotMatch(relayClientSource, /handshakeTimeout: 10_000/);

const coreToolSource = readFileSync("src/tools/core.ts", "utf8");
assert.match(coreToolSource, /const HTTP_TOOL_TIMEOUT_MS = config\.MCP_HTTP_TOOL_TIMEOUT_MS;/);
assert.match(coreToolSource, /AbortSignal\.timeout\(HTTP_TOOL_TIMEOUT_MS\)/);
assert.doesNotMatch(coreToolSource, /AbortSignal\.timeout\(30_000\)/);

const sandboxSource = readFileSync("src/workspace/sandbox.ts", "utf8");
assert.match(sandboxSource, /const WORKSPACE_BRANCH_PROBE_TIMEOUT_MS = config\.MCP_WORKSPACE_BRANCH_PROBE_TIMEOUT_MS;/);
assert.match(sandboxSource, /timeout: WORKSPACE_BRANCH_PROBE_TIMEOUT_MS/);
assert.doesNotMatch(sandboxSource, /timeout: 2_000/);

const gitHistorySource = readFileSync("src/tools/git-history.ts", "utf8");
assert.match(gitHistorySource, /const GIT_HISTORY_TIMEOUT_MS = config\.MCP_GIT_HISTORY_TIMEOUT_MS;/);
assert.match(gitHistorySource, /timeout: GIT_HISTORY_TIMEOUT_MS/);
assert.doesNotMatch(gitHistorySource, /timeout: 60_000/);

const commandToolSource = readFileSync("src/tools/command.ts", "utf8");
assert.match(commandToolSource, /const PROCESS_KILL_GRACE_MS = config\.MCP_PROCESS_KILL_GRACE_MS;/);
assert.match(commandToolSource, /setTimeout\(\(\) => child\.kill\("SIGKILL"\), PROCESS_KILL_GRACE_MS\)/);
assert.doesNotMatch(commandToolSource, /setTimeout\(\(\) => child\.kill\("SIGKILL"\), 2_000\)/);

const copilotExecuteSource = readFileSync("src/tools/copilot-execute.ts", "utf8");
assert.match(copilotExecuteSource, /const PROCESS_KILL_GRACE_MS = config\.MCP_PROCESS_KILL_GRACE_MS;/);
assert.match(copilotExecuteSource, /setTimeout\(\(\) => child\.kill\("SIGKILL"\), PROCESS_KILL_GRACE_MS\)/);
assert.doesNotMatch(copilotExecuteSource, /setTimeout\(\(\) => child\.kill\("SIGKILL"\), 2_000\)/);

console.log("mcp runtime env config contract tests passed");
