import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

function fakeDockerSpawn(calls: Array<{ command: string; args: string[] }>) {
  return ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stdout.write("runner ok\n");
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  }) as never;
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

async function withRunnerEnv<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "mcp-runner-"));
  const oldEnv = { ...process.env };
  try {
    vi.resetModules();
    process.env = {
      ...oldEnv,
      NODE_ENV: "test",
      PORT: "7110",
      MCP_RUNNER_TOKEN: "test-runner-token-min-16",
      MCP_RUNNER_HOST_WORKSPACE_PATH: root,
      MCP_RUNNER_WORKSPACE_CONTAINER_PATH: "/workspace",
      MCP_RUNNER_DEFAULT_IMAGE: "node:20-alpine",
      MCP_RUNNER_IMAGE_MAP_JSON: JSON.stringify({ pytest: "python:3.12-slim" }),
      MCP_RUNNER_NETWORK_MODE: "none",
      MCP_RUNNER_CPU_LIMIT: "0.5",
      MCP_RUNNER_MEMORY_LIMIT: "512m",
      MCP_RUNNER_PIDS_LIMIT: "64",
    };
    return await fn(root);
  } finally {
    process.env = oldEnv;
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mcp-sandbox-runner docker execution", () => {
  const runnerToken = "test-runner-token-min-16";

  it("builds a hardened ephemeral Docker invocation and returns isolation evidence", async () => {
    await withRunnerEnv(async (root) => {
      const calls: Array<{ command: string; args: string[] }> = [];
      const { executeInDocker } = await import("../src/runner/docker-exec");

      const receipt = await executeInDocker({
        command: "pytest",
        args: ["-q"],
        cwd: "tests",
        timeoutMs: 1000,
        maxOutputChars: 2000,
      }, { spawnImpl: fakeDockerSpawn(calls) });

      expect(receipt).toMatchObject({
        kind: "verification_result",
        command: "pytest -q",
        passed: true,
        execution_mode: "container",
        container_image: "python:3.12-slim",
        network_mode: "none",
        isolation: {
          runner: "mcp-sandbox-runner",
          network: "none",
          readonlyRoot: true,
          noNewPrivileges: true,
          capDrop: "ALL",
        },
      });
      expect(calls).toHaveLength(1);
      const args = calls[0].args;
      expect(calls[0].command).toBe("docker");
      expect(args).toEqual(expect.arrayContaining([
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--cpus",
        "0.5",
        "--memory",
        "512m",
        "--pids-limit",
        "64",
        "-v",
        `${root}:/workspace:rw`,
        "-w",
        "/workspace/tests",
        "python:3.12-slim",
        "pytest",
        "-q",
      ]));
    });
  });

  it("rejects cwd traversal before invoking Docker", async () => {
    await withRunnerEnv(async () => {
      const calls: Array<{ command: string; args: string[] }> = [];
      const { executeInDocker } = await import("../src/runner/docker-exec");

      await expect(executeInDocker({
        command: "node",
        args: ["--version"],
        cwd: "../outside",
      }, { spawnImpl: fakeDockerSpawn(calls) })).rejects.toThrow("cwd escapes the sandbox root");
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects non-allowlisted shell commands before invoking Docker", async () => {
    await withRunnerEnv(async () => {
      const calls: Array<{ command: string; args: string[] }> = [];
      const { executeInDocker } = await import("../src/runner/docker-exec");

      await expect(executeInDocker({
        command: "sh",
        args: ["-c", "npm test"],
        cwd: ".",
      }, { spawnImpl: fakeDockerSpawn(calls) })).rejects.toThrow("not allowed by the runner policy");
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects malformed execute requests and bad bearer tokens", async () => {
    await withRunnerEnv(async () => {
      const { createRunnerApp } = await import("../src/runner/server");
      const server = createServer(createRunnerApp());
      const port = await listen(server);
      try {
        const badAuth = await fetch(`http://127.0.0.1:${port}/v1/execute`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
          body: JSON.stringify({ command: "node", args: ["--version"] }),
        });
        expect(badAuth.status).toBe(401);

        const malformed = await fetch(`http://127.0.0.1:${port}/v1/execute`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${runnerToken}` },
          body: JSON.stringify({ command: "" }),
        });
        expect(malformed.status).toBe(400);

        const denied = await fetch(`http://127.0.0.1:${port}/v1/execute`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${runnerToken}` },
          body: JSON.stringify({ command: "sh", args: ["-c", "npm test"] }),
        });
        expect(denied.status).toBe(400);
      } finally {
        await close(server);
      }
    });
  });

  it("applies a per-request network override and env flags (run_python path)", async () => {
    await withRunnerEnv(async () => {
      const calls: Array<{ command: string; args: string[] }> = [];
      const { executeInDocker } = await import("../src/runner/docker-exec");

      const receipt = await executeInDocker({
        command: "python3",
        args: ["__wf_python_abc.py"],
        cwd: ".",
        timeoutMs: 1000,
        network: "bridge",
        env: { NAME: "world", LOG_LEVEL: "INFO" },
      }, { spawnImpl: fakeDockerSpawn(calls) });

      expect(receipt).toMatchObject({ network_mode: "bridge", isolation: { network: "bridge" } });
      const args = calls[0].args;
      // network override beats the global MCP_RUNNER_NETWORK_MODE=none
      const netIdx = args.indexOf("--network");
      expect(args[netIdx + 1]).toBe("bridge");
      // env injected as -e KEY=VALUE pairs
      expect(args).toEqual(expect.arrayContaining(["-e", "NAME=world", "-e", "LOG_LEVEL=INFO"]));
    });
  });

  it("rejects invalid env keys before invoking Docker", async () => {
    await withRunnerEnv(async () => {
      const calls: Array<{ command: string; args: string[] }> = [];
      const { executeInDocker } = await import("../src/runner/docker-exec");

      await expect(executeInDocker({
        command: "python3",
        args: ["__wf_python_abc.py"],
        cwd: ".",
        env: { "BAD KEY": "x" },
      }, { spawnImpl: fakeDockerSpawn(calls) })).rejects.toThrow(/invalid env/i);
      expect(calls).toHaveLength(0);
    });
  });
});
