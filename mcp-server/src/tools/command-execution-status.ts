import path from "node:path";
import { config } from "../config";
import { sandboxRunnerStatus } from "./runner-client";

export function commandPolicySummary() {
  return {
    allowedFamilies: [
      "package-manager test/lint/typecheck/build/check/verify scripts",
      "read-only git status/diff/log/show/rev-parse/branch/ls-files/describe",
      "pytest, python -m pytest/unittest/compileall/py_compile",
      "go test/vet/build/list, cargo test/check/build/clippy/fmt --check",
      "mvn test/verify/compile/package, gradle test/check/build/verify, dotnet test/build",
      "rg diagnostics",
    ],
    deniedFamilies: [
      "install/add/ci/restore",
      "publish/deploy/release",
      "login/token/config/global mutation",
      "git mutation/network commands",
      "shell operators and absolute/traversal command paths",
      "secret-looking env or credential arguments",
    ],
  };
}

export async function commandExecutionStatus() {
  const mode = config.MCP_COMMAND_EXECUTION_MODE;
  const base = {
    mode,
    runnerUrl: config.MCP_RUNNER_URL,
    runnerTokenConfigured: Boolean(config.MCP_RUNNER_TOKEN?.trim()),
    hostWorkspacePath: config.MCP_RUNNER_HOST_WORKSPACE_PATH ?? null,
    hostWorkspacePathAbsolute: config.MCP_RUNNER_HOST_WORKSPACE_PATH
      ? path.isAbsolute(config.MCP_RUNNER_HOST_WORKSPACE_PATH)
      : false,
    defaultImage: config.MCP_RUNNER_DEFAULT_IMAGE,
    imageMapConfigured: Boolean(config.MCP_RUNNER_IMAGE_MAP_JSON?.trim()),
    networkMode: config.MCP_RUNNER_NETWORK_MODE,
    policy: commandPolicySummary(),
    error: undefined as string | undefined,
  };
  if (mode !== "container") {
    return {
      ...base,
      status: "process",
      ready: true,
      runner: null,
    };
  }
  try {
    const runner = await sandboxRunnerStatus();
    const runnerReady = runner.ready !== false && runner.status !== "degraded";
    return {
      ...base,
      status: runnerReady ? "container" : "unavailable",
      ready: runnerReady,
      error: runnerReady ? undefined : "runner health is degraded",
      runner,
    };
  } catch (err) {
    return {
      ...base,
      status: "unavailable",
      ready: false,
      error: (err as Error).message,
      runner: null,
    };
  }
}
