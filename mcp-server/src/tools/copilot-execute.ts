import { spawn } from "node:child_process";
import type { ToolHandler } from "./registry";
import { resolveSandboxedPath } from "../workspace/sandbox";
import { log } from "../shared/log";

/**
 * §13.4 — "mcp invokes Copilot". context-fabric dispatches this tool to
 * mcp-server (the user's laptop mcp-server via the WS bridge when laptop_user_id
 * is set); mcp-server invokes the official GitHub Copilot CLI to do a whole
 * coding phase agentically inside the work-item's sandbox workspace, then
 * captures the CLI summary + the git diff as a code-change receipt.
 *
 * This is the server-orchestrated executor model (CF → MCP → Copilot CLI), as
 * opposed to the CLI-driven bin/copilot-execute.js. The CLI is an AGENT — in
 * `-p --allow-all` it edits files + runs commands itself and returns TEXT, not
 * OpenAI tool_calls — so CF delegates the phase to it rather than driving a
 * function-calling loop. The workspace is already materialized by /mcp/tool-run
 * (ensureWorkspaceSource) before this tool runs, so cwd = the sandbox root.
 */
const COPILOT_BIN = process.env.COPILOT_BIN || "copilot";
const DEFAULT_TIMEOUT_MS = 900_000; // 15 min — agentic phases are slow
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_SUMMARY_CHARS = 16_000;
const MAX_DIFF_CHARS = 200_000;

interface SpawnResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function spawnCapture(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); });
    child.on("close", (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}\n... truncated (${s.length - max} more chars) ...`;

export const copilotExecuteTool: ToolHandler = {
  descriptor: {
    name: "copilot_execute",
    description:
      "Delegate a whole coding task to the GitHub Copilot CLI (`copilot -p --allow-all`) inside the MCP sandbox workspace. " +
      "The CLI explores, edits files, and runs commands itself, then returns a text summary; this tool captures that summary " +
      "PLUS the resulting git diff + changed paths as a code-change receipt. Use this to run an agentic implementation phase " +
      "when the executing model is the Copilot CLI (which returns text, not tool_calls).",
    natural_language:
      "Use this to hand an implementation task to the Copilot CLI to complete end-to-end in the workspace, capturing the diff as evidence.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The implementation task / prompt for Copilot to execute in the workspace." },
        timeout_ms: { type: "number", description: "Max milliseconds for the CLI run (default 900000, max 1800000)." },
        commit: { type: "boolean", description: "Commit the resulting changes onto the work-item branch (default true)." },
        commit_message: { type: "string", description: "Commit message; defaults to 'copilot: <first line of task>'." },
      },
      required: ["task"],
    },
    output_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        changedPaths: { type: "array", items: { type: "string" } },
        diff: { type: "string" },
      },
    },
    // Mutating + command-executing — the CLI edits files and runs commands.
    risk_level: "HIGH",
    requires_approval: false,
  },
  async execute(args) {
    const task = String(args.task ?? "").trim();
    if (!task) return { success: false, output: null, error: "task is required" };
    const timeoutMs = typeof args.timeout_ms === "number" && args.timeout_ms > 0
      ? Math.min(Math.floor(args.timeout_ms), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
    const cwd = resolveSandboxedPath(".");
    const started = Date.now();

    let res: SpawnResult;
    try {
      res = await spawnCapture(COPILOT_BIN, ["-p", task, "--allow-all"], cwd, timeoutMs);
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `failed to spawn '${COPILOT_BIN}': ${(err as Error).message}. Is the Copilot CLI installed and on PATH on this mcp-server?`,
      };
    }
    // The CLI sometimes exits non-zero but still produced useful work; only treat
    // a non-zero exit WITH no stdout as a hard failure.
    if (res.code !== 0 && !res.stdout.trim()) {
      return { success: false, output: null, error: `copilot CLI exited ${res.code}: ${(res.stderr || "").slice(0, 500)}` };
    }

    // Capture the code-change evidence from the now-mutated workspace.
    let diff = "";
    let changedPaths: string[] = [];
    try {
      diff = (await spawnCapture("git", ["diff"], cwd, 30_000)).stdout;
      const porcelain = (await spawnCapture("git", ["status", "--porcelain"], cwd, 30_000)).stdout;
      changedPaths = porcelain.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "copilot_execute: git diff capture failed");
    }

    // Check in: commit this phase's changes onto the work-item branch so the
    // workflow's GIT_PUSH can push them and each stage has a discrete commit.
    // (Default true; pass commit:false to leave the worktree dirty.)
    let commitSha: string | undefined;
    const shouldCommit = args.commit !== false && changedPaths.length > 0;
    if (shouldCommit) {
      try {
        await spawnCapture("git", ["add", "-A"], cwd, 30_000);
        const msg = (typeof args.commit_message === "string" && args.commit_message.trim())
          ? args.commit_message.trim()
          : `copilot: ${task.split("\n")[0].slice(0, 72)}`;
        const c = await spawnCapture(
          "git",
          ["-c", "user.email=copilot@singularity.local", "-c", "user.name=Singularity Copilot", "commit", "-m", msg],
          cwd, 30_000,
        );
        if (c.code === 0) commitSha = (await spawnCapture("git", ["rev-parse", "HEAD"], cwd, 10_000)).stdout.trim();
        else log.warn({ stderr: c.stderr.slice(0, 200) }, "copilot_execute: git commit non-zero");
      } catch (err) {
        log.warn({ err: (err as Error).message }, "copilot_execute: commit failed");
      }
    }

    return {
      success: true,
      output: {
        kind: "copilot_execution",
        executor: "copilot-cli",
        summary: truncate(res.stdout.trim(), MAX_SUMMARY_CHARS),
        changedPaths,
        diff: truncate(diff, MAX_DIFF_CHARS),
        commitSha,
        timed_out: res.timedOut,
        exit_code: res.code,
        duration_ms: Date.now() - started,
      },
    };
  },
};
