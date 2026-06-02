import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolHandler } from "./registry";
import { config } from "../config";
import { resolveSandboxedPath, sandboxRoot, baseSandboxRoot } from "../workspace/sandbox";
import { callSandboxRunner } from "./runner-client";

/**
 * run_python — execute an INLINE Python program in the sandbox runner.
 *
 * This is the executor for the workflow `RUN_PYTHON` node. Unlike run_command
 * (command.ts), it deliberately does NOT go through validatePolicy — that
 * allowlist restricts `python` to `-m pytest/unittest/...`, which can't run an
 * arbitrary script. Running arbitrary Python is safe here ONLY because:
 *   - it executes in the same hardened ephemeral container (--read-only,
 *     --cap-drop ALL, --no-new-privileges, cpu/mem/pids limits, tmpfs),
 *   - the sandbox is empty (the RUN_PYTHON executor omits sourceUri, so no repo
 *     is materialised),
 *   - network defaults to "none" and is only widened to "bridge" on explicit
 *     opt-in (allow_network),
 *   - the tool is invoked ONLY by the workflow executor — it is intentionally
 *     kept out of the agent-facing tools.json manifests, so the LLM tool-picker
 *     can never select it.
 *
 * The source is written to a per-invocation file in the sandbox, run as
 * `python3 <file> [args...]`, and the file is removed afterward.
 */

const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
const MAX_OUTPUT_CHARS = 100_000;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseEnv(raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("env must be an object of string keys to string values");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_KEY_RE.test(key)) throw new Error(`invalid env key: ${key}`);
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
      throw new Error(`invalid env value for ${key}`);
    }
    out[key] = value;
  }
  return out;
}

function parseArgs(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((a) => String(a));
  throw new Error("args must be an array of strings");
}

const pythonInputSchema = {
  type: "object",
  properties: {
    code: { type: "string", description: "Inline Python source to execute." },
    args: { type: "array", items: { type: "string" }, description: "Optional argv passed after the script." },
    env: { type: "object", description: "Optional environment variables injected into the sandbox." },
    timeout_ms: { type: "number", description: "Timeout in milliseconds, max 600000 (default 120000)." },
    allow_network: { type: "boolean", description: "Opt into outbound network for this run (default false → no network)." },
    max_output_chars: { type: "number", description: "Maximum stdout/stderr excerpt chars." },
  },
  required: ["code"],
};

export const runPythonTool: ToolHandler = {
  descriptor: {
    name: "run_python",
    description:
      "Execute an inline Python program in an isolated sandbox container and return stdout/stderr/exit_code. " +
      "Executor-only (workflow RUN_PYTHON node) — not for agent use.",
    natural_language:
      "Runs a provided Python script in a hardened ephemeral container. Network is off unless explicitly allowed.",
    input_schema: pythonInputSchema,
    risk_level: "HIGH",
    requires_approval: false,
  },
  async execute(args) {
    let scriptAbs: string | null = null;
    try {
      const code = typeof args.code === "string" ? args.code : "";
      if (!code.trim()) {
        return { success: false, output: null, error: "run_python: 'code' is required", error_code: "VALIDATION" };
      }
      const scriptArgs = parseArgs(args.args);
      const env = parseEnv(args.env);
      const timeoutMs = typeof args.timeout_ms === "number" && args.timeout_ms > 0
        ? Math.min(Math.floor(args.timeout_ms), MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;
      const maxOutputChars = typeof args.max_output_chars === "number" && args.max_output_chars > 0
        ? Math.min(Math.floor(args.max_output_chars), MAX_OUTPUT_CHARS)
        : DEFAULT_MAX_OUTPUT_CHARS;
      const allowNetwork = args.allow_network === true;

      if (config.MCP_COMMAND_EXECUTION_MODE !== "container") {
        return {
          success: false,
          output: null,
          error: "run_python requires MCP_COMMAND_EXECUTION_MODE=container (sandbox runner)",
          error_code: "SANDBOX",
        };
      }

      // Write the source to a per-invocation file in the (per-instance) sandbox
      // root. The runner mounts the BASE sandbox root at /workspace, so we pass
      // the script as a bare filename and set cwd to the sandbox dir relative to
      // the base root (mirrors runCommand's relativeCwd handling in command.ts).
      const fileName = `__wf_python_${randomUUID()}.py`;
      scriptAbs = resolveSandboxedPath(fileName);
      const relativeCwd = path.relative(baseSandboxRoot(), sandboxRoot()) || ".";
      await fs.promises.mkdir(path.dirname(scriptAbs), { recursive: true });
      await fs.promises.writeFile(scriptAbs, code, "utf8");

      const receipt = await callSandboxRunner({
        command: "python3",
        args: [fileName, ...scriptArgs],
        cwd: relativeCwd,
        timeoutMs,
        maxOutputChars,
        network: allowNetwork ? "bridge" : "none",
        env,
      });

      return { success: true, output: { ...receipt, verification_kind: "python" } };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    } finally {
      if (scriptAbs) await fs.promises.rm(scriptAbs, { force: true }).catch(() => {});
    }
  },
};
