import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandTool, runTestTool } from "../src/tools/command";
import { withSandboxRoot } from "../src/workspace/sandbox";

async function withTempSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "mcp-command-"));
  try {
    return await withSandboxRoot(root, () => fn(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP command tools policy", () => {
  it("run_test emits a process verification receipt in test mode", async () => {
    await withTempSandbox(async () => {
      const result = await runTestTool.execute({ command: "node", args: ["--version"] });

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        kind: "verification_result",
        verification_kind: "test",
        passed: true,
        execution_mode: "process",
        network_mode: "host-process",
      });
    });
  });

  it("rejects shell operators, install/deploy verbs, absolute executables, and secret-looking args", async () => {
    await withTempSandbox(async () => {
      await expect(runCommandTool.execute({ command: "npm test && npm install" })).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("shell operators"),
      });
      await expect(runCommandTool.execute({ command: "npm", args: ["install"] })).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("install"),
      });
      await expect(runCommandTool.execute({ command: "/bin/node", args: ["--version"] })).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("absolute command paths"),
      });
      await expect(runCommandTool.execute({ command: "node", args: ["--test", "$OPENAI_API_KEY"] })).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("secret-looking"),
      });
    });
  });
});

describe("MCP command tools container runner", () => {
  it("routes container mode through the runner and returns isolation metadata", async () => {
    const runnerToken = "test-runner-token-min-16";
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/execute") {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${runnerToken}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ success: false, error: "bad token" }));
        return;
      }
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        requests.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          success: true,
          data: {
            kind: "verification_result",
            command: "npm test",
            exit_code: 0,
            passed: true,
            timed_out: false,
            duration_ms: 12,
            stdout_excerpt: "ok",
            stderr_excerpt: "",
            execution_mode: "container",
            runner_receipt_id: "runner_123",
            container_image: "node:20-alpine",
            container_id: "mcp-runner-runner_123",
            network_mode: "none",
            isolation: { runner: "mcp-sandbox-runner", network: "none", readonlyRoot: true, noNewPrivileges: true },
          },
        }));
      });
    });
    const port = await listen(server);
    const root = mkdtempSync(join(tmpdir(), "mcp-command-container-"));
    const oldEnv = { ...process.env };
    try {
      vi.resetModules();
      process.env = {
        ...oldEnv,
        NODE_ENV: "development",
        MCP_BEARER_TOKEN: "test-bearer-token-12345-min-16-chars",
        LLM_GATEWAY_URL: "mock",
        MCP_SANDBOX_ROOT: root,
        MCP_COMMAND_EXECUTION_MODE: "container",
        MCP_RUNNER_URL: `http://127.0.0.1:${port}`,
        MCP_RUNNER_TOKEN: runnerToken,
      };
      const { runTestTool: containerRunTestTool } = await import("../src/tools/command");
      const { withSandboxRoot: freshWithSandboxRoot } = await import("../src/workspace/sandbox");
      const result = await freshWithSandboxRoot(root, () => containerRunTestTool.execute({ command: "npm test", cwd: "." }));

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        verification_kind: "test",
        execution_mode: "container",
        runner_receipt_id: "runner_123",
        container_image: "node:20-alpine",
        network_mode: "none",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        command: "npm",
        args: ["test"],
        cwd: ".",
      });
    } finally {
      process.env = oldEnv;
      rmSync(root, { recursive: true, force: true });
      await close(server);
      vi.resetModules();
    }
  });

  it("does not fall back to host process execution when the runner is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-command-runner-down-"));
    const oldEnv = { ...process.env };
    const runnerToken = "test-runner-token-min-16";
    try {
      vi.resetModules();
      process.env = {
        ...oldEnv,
        NODE_ENV: "development",
        MCP_BEARER_TOKEN: "test-bearer-token-12345-min-16-chars",
        LLM_GATEWAY_URL: "mock",
        MCP_SANDBOX_ROOT: root,
        MCP_COMMAND_EXECUTION_MODE: "container",
        MCP_RUNNER_URL: "http://127.0.0.1:9",
        MCP_RUNNER_TOKEN: runnerToken,
      };
      const { runTestTool: containerRunTestTool } = await import("../src/tools/command");
      const { withSandboxRoot: freshWithSandboxRoot } = await import("../src/workspace/sandbox");
      const result = await freshWithSandboxRoot(root, () => containerRunTestTool.execute({ command: "node --version" }));

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("MCP_RUNNER_UNAVAILABLE"),
      });
    } finally {
      process.env = oldEnv;
      rmSync(root, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
