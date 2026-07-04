import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ToolHandler } from "./registry";
import { config } from "../config";
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
const DEFAULT_TIMEOUT_MS = config.MCP_COPILOT_EXECUTE_DEFAULT_TIMEOUT_MS;
const MAX_TIMEOUT_MS = config.MCP_COPILOT_EXECUTE_MAX_TIMEOUT_MS;
const GIT_HASH_TIMEOUT_MS = config.MCP_WORKTREE_GIT_HASH_TIMEOUT_MS;
const GIT_WRITE_TIMEOUT_MS = config.MCP_WORKTREE_GIT_WRITE_TIMEOUT_MS;
const MAX_SUMMARY_CHARS = 16_000;
const MAX_DIFF_CHARS = 200_000;
const PROCESS_KILL_GRACE_MS = config.MCP_PROCESS_KILL_GRACE_MS;

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
      setTimeout(() => child.kill("SIGKILL"), PROCESS_KILL_GRACE_MS).unref();
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
        timeout_ms: { type: "number", description: "Max milliseconds for the CLI run, capped by MCP_COPILOT_EXECUTE_MAX_TIMEOUT_MS." },
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
        diffTruncated: { type: "boolean" },
        diffFullChars: { type: "number" },
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

    // Observability: log the exact prompt handed to the Copilot CLI so operators
    // can see what was sent (tail logs/mcp-server.log). Echoed in the output too.
    log.info({ cwd, promptChars: task.length, prompt: task.slice(0, 2000) }, "copilot_execute → copilot -p (prompt sent)");

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
      diff = (await spawnCapture("git", ["diff"], cwd, GIT_WRITE_TIMEOUT_MS)).stdout;
      const porcelain = (await spawnCapture("git", ["status", "--porcelain"], cwd, GIT_WRITE_TIMEOUT_MS)).stdout;
      changedPaths = porcelain.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "copilot_execute: git diff capture failed");
    }

    // Capture produced file CONTENT (the actual artifacts — REQUIREMENTS.md etc.)
    // so the platform can store + show each doc per phase, not just the summary.
    const artifacts: Array<{ path: string; content: string }> = [];
    for (const p of changedPaths.slice(0, 25)) {
      if (!p || p.endsWith("/")) continue;
      try {
        const content = readFileSync(resolveSandboxedPath(p), "utf8");
        if (content.length <= 200_000) artifacts.push({ path: p, content });
      } catch { /* deleted, binary, or a directory — skip */ }
    }

    // Check in: commit this phase's changes onto the work-item branch so the
    // workflow's GIT_PUSH can push them and each stage has a discrete commit.
    // (Default true; pass commit:false to leave the worktree dirty.)
    let commitSha: string | undefined;
    const shouldCommit = args.commit !== false && changedPaths.length > 0;
    if (shouldCommit) {
      try {
        await spawnCapture("git", ["add", "-A"], cwd, GIT_WRITE_TIMEOUT_MS);
        const msg = (typeof args.commit_message === "string" && args.commit_message.trim())
          ? args.commit_message.trim()
          : `copilot: ${task.split("\n")[0].slice(0, 72)}`;
        const c = await spawnCapture(
          "git",
          ["-c", "user.email=copilot@singularity.local", "-c", "user.name=Singularity Copilot", "commit", "-m", msg],
          cwd, GIT_WRITE_TIMEOUT_MS,
        );
        if (c.code === 0) commitSha = (await spawnCapture("git", ["rev-parse", "HEAD"], cwd, GIT_HASH_TIMEOUT_MS)).stdout.trim();
        else log.warn({ stderr: c.stderr.slice(0, 200) }, "copilot_execute: git commit non-zero");
      } catch (err) {
        log.warn({ err: (err as Error).message }, "copilot_execute: commit failed");
      }
    }

    // Log Copilot's actual stdout (its summary / any error like
    // "transient_bad_request") + stderr so failures are visible in the log, not
    // just the result metadata. Especially important when exitCode!=0 or no files
    // changed but the run still "completed".
    log.info(
      {
        durationMs: Date.now() - started, exitCode: res.code, timedOut: res.timedOut, changedPaths, commitSha,
        output: res.stdout.slice(0, 2000),
        ...(res.stderr.trim() ? { stderr: res.stderr.slice(0, 800) } : {}),
      },
      "copilot_execute ← completed",
    );
    // [P1] Make diff truncation explicit in the receipt. The diff is clipped to
    // MAX_DIFF_CHARS with an in-body marker, but a consumer that reads the diff
    // structurally (governance evidence, DIFF_VS_DESIGN, the evidence pack) must
    // be able to tell a clipped diff from a complete one — not silently trust a
    // partial body. Surface a structured flag + the full length.
    const diffFullChars = diff.length;
    const diffTruncated = diffFullChars > MAX_DIFF_CHARS;
    return {
      success: true,
      output: {
        kind: "copilot_execution",
        executor: "copilot-cli",
        prompt: truncate(task, MAX_SUMMARY_CHARS),
        summary: truncate(res.stdout.trim(), MAX_SUMMARY_CHARS),
        changedPaths,
        artifacts,
        diff: truncate(diff, MAX_DIFF_CHARS),
        diffTruncated,
        diffFullChars,
        commitSha,
        timed_out: res.timedOut,
        exit_code: res.code,
        duration_ms: Date.now() - started,
      },
    };
  },
};
