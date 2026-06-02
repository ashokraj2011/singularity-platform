import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

// Force container mode (the suite default is process mode) while preserving all
// other real config fields so workspace/sandbox.ts keeps working.
vi.mock("../src/config", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/config")>();
  return { ...mod, config: { ...mod.config, MCP_COMMAND_EXECUTION_MODE: "container" } };
});
// Stub the runner so no real Docker is needed.
vi.mock("../src/tools/runner-client", () => ({ callSandboxRunner: vi.fn() }));

import { runPythonTool } from "../src/tools/python";
import { withSandboxRoot } from "../src/workspace/sandbox";
import { callSandboxRunner } from "../src/tools/runner-client";

async function withTempSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "mcp-python-"));
  try {
    return await withSandboxRoot(root, () => fn(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("run_python tool", () => {
  it("rejects when no code is provided", async () => {
    const res = await runPythonTool.execute({});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/code.*required/i);
  });

  it("rejects an invalid env key before running anything", async () => {
    const res = await runPythonTool.execute({ code: "print(1)", env: { "BAD KEY": "x" } });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/invalid env key/i);
  });

  it("writes the script, runs python3 in the sandbox with network+env, and cleans up", async () => {
    (callSandboxRunner as Mock).mockResolvedValue({
      kind: "verification_result",
      exit_code: 0,
      passed: true,
      stdout_excerpt: "hello world",
      stderr_excerpt: "",
      timed_out: false,
      duration_ms: 12,
      network_mode: "bridge",
      runner_receipt_id: "r-1",
    });

    await withTempSandbox(async (root) => {
      const res = await runPythonTool.execute({
        code: "import os; print('hello ' + os.environ['NAME'])",
        args: ["--flag"],
        env: { NAME: "world" },
        allow_network: true,
        timeout_ms: 30_000,
      });

      expect(res.success).toBe(true);
      expect(res.output).toMatchObject({ exit_code: 0, stdout_excerpt: "hello world", verification_kind: "python" });

      expect(callSandboxRunner).toHaveBeenCalledTimes(1);
      const req = (callSandboxRunner as Mock).mock.calls[0][0];
      expect(req.command).toBe("python3");
      expect(req.args[0]).toMatch(/^__wf_python_.*\.py$/);
      expect(req.args).toContain("--flag");
      expect(req.network).toBe("bridge");
      expect(req.env).toEqual({ NAME: "world" });

      // the temp script file is removed after the run
      const leftover = readdirSync(root).filter((f) => f.startsWith("__wf_python_"));
      expect(leftover).toEqual([]);
    });
  });

  it("defaults to no network when allow_network is not set", async () => {
    (callSandboxRunner as Mock).mockResolvedValue({ exit_code: 0, passed: true, stdout_excerpt: "", stderr_excerpt: "", timed_out: false });
    await withTempSandbox(async () => {
      await runPythonTool.execute({ code: "print(1)" });
      const req = (callSandboxRunner as Mock).mock.calls[0][0];
      expect(req.network).toBe("none");
    });
  });
});
