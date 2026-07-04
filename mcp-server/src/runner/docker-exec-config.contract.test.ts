import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE_ENV = {
  ...process.env,
  MCP_RUNNER_TOKEN: "test-runner-token-12345",
  MCP_RUNNER_HOST_WORKSPACE_PATH: process.cwd(),
};

function runRunnerConfig(extraEnv: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      "-e",
      [
        "const { runnerConfig } = require('./src/runner/config');",
        "console.log([",
        "runnerConfig.MCP_RUNNER_DOCKER_EXECUTE_DEFAULT_TIMEOUT_MS,",
        "runnerConfig.MCP_RUNNER_DOCKER_EXECUTE_MAX_TIMEOUT_MS,",
        "runnerConfig.MCP_RUNNER_DOCKER_KILL_GRACE_MS,",
        "runnerConfig.MCP_RUNNER_DOCKER_HEALTH_TIMEOUT_MS",
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

const defaults = runRunnerConfig({});
assert.equal(defaults.status, 0, defaults.stderr);
assert.match(defaults.stdout, /120000:600000:2000:1500/);

const custom = runRunnerConfig({
  MCP_RUNNER_DOCKER_EXECUTE_DEFAULT_TIMEOUT_MS: "180000",
  MCP_RUNNER_DOCKER_EXECUTE_MAX_TIMEOUT_MS: "900000",
  MCP_RUNNER_DOCKER_KILL_GRACE_MS: "3500",
  MCP_RUNNER_DOCKER_HEALTH_TIMEOUT_MS: "2500",
});
assert.equal(custom.status, 0, custom.stderr);
assert.match(custom.stdout, /180000:900000:3500:2500/);

const invertedExecuteTimeouts = runRunnerConfig({
  MCP_RUNNER_DOCKER_EXECUTE_DEFAULT_TIMEOUT_MS: "900000",
  MCP_RUNNER_DOCKER_EXECUTE_MAX_TIMEOUT_MS: "600000",
});
assert.notEqual(invertedExecuteTimeouts.status, 0);
assert.match(invertedExecuteTimeouts.stderr, /MCP_RUNNER_DOCKER_EXECUTE_DEFAULT_TIMEOUT_MS/);

for (const [name, value] of [
  ["MCP_RUNNER_DOCKER_EXECUTE_DEFAULT_TIMEOUT_MS", "0"],
  ["MCP_RUNNER_DOCKER_EXECUTE_MAX_TIMEOUT_MS", "0"],
  ["MCP_RUNNER_DOCKER_EXECUTE_DEFAULT_TIMEOUT_MS", "99999999"],
  ["MCP_RUNNER_DOCKER_EXECUTE_MAX_TIMEOUT_MS", "99999999"],
  ["MCP_RUNNER_DOCKER_KILL_GRACE_MS", "0"],
  ["MCP_RUNNER_DOCKER_HEALTH_TIMEOUT_MS", "0"],
  ["MCP_RUNNER_DOCKER_KILL_GRACE_MS", "999999"],
  ["MCP_RUNNER_DOCKER_HEALTH_TIMEOUT_MS", "999999"],
] as const) {
  const result = runRunnerConfig({ [name]: value });
  assert.notEqual(result.status, 0, `${name}=${value} should be rejected`);
  assert.match(result.stderr, new RegExp(name));
}

const configSource = readFileSync("src/runner/config.ts", "utf8");
assert.match(configSource, /MCP_RUNNER_DOCKER_EXECUTE_DEFAULT_TIMEOUT_MS: boundedPositiveInt\(120_000, RUNNER_LIMITS\.DOCKER_EXECUTE_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_RUNNER_DOCKER_EXECUTE_MAX_TIMEOUT_MS: boundedPositiveInt\(600_000, RUNNER_LIMITS\.DOCKER_EXECUTE_TIMEOUT_MS\)/);
assert.match(configSource, /MCP_RUNNER_DOCKER_EXECUTE_DEFAULT_TIMEOUT_MS must be less than or equal to[\s\S]*?MCP_RUNNER_DOCKER_EXECUTE_MAX_TIMEOUT_MS/);
assert.match(configSource, /MCP_RUNNER_DOCKER_KILL_GRACE_MS: boundedPositiveInt\(2_000, RUNNER_LIMITS\.DOCKER_KILL_GRACE_MS\)/);
assert.match(configSource, /MCP_RUNNER_DOCKER_HEALTH_TIMEOUT_MS: boundedPositiveInt\(1_500, RUNNER_LIMITS\.DOCKER_HEALTH_TIMEOUT_MS\)/);

const dockerExecSource = readFileSync("src/runner/docker-exec.ts", "utf8");
assert.match(dockerExecSource, /const DEFAULT_TIMEOUT_MS = runnerConfig\.MCP_RUNNER_DOCKER_EXECUTE_DEFAULT_TIMEOUT_MS;/);
assert.match(dockerExecSource, /const MAX_TIMEOUT_MS = runnerConfig\.MCP_RUNNER_DOCKER_EXECUTE_MAX_TIMEOUT_MS;/);
assert.match(dockerExecSource, /timeoutMs: z\.number\(\)\.int\(\)\.positive\(\)\.max\(MAX_TIMEOUT_MS\)\.optional\(\)/);
assert.match(dockerExecSource, /runnerConfig\.MCP_RUNNER_DOCKER_KILL_GRACE_MS/);
assert.match(dockerExecSource, /timeout: runnerConfig\.MCP_RUNNER_DOCKER_HEALTH_TIMEOUT_MS/);
assert.doesNotMatch(dockerExecSource, /const DEFAULT_TIMEOUT_MS = 120_000/);
assert.doesNotMatch(dockerExecSource, /const MAX_TIMEOUT_MS = 600_000/);
assert.doesNotMatch(dockerExecSource, /setTimeout\(\(\) => child\.kill\("SIGKILL"\), 2_000\)/);
assert.doesNotMatch(dockerExecSource, /timeout: 1_500/);

console.log("mcp sandbox runner docker-exec config contract tests passed");
