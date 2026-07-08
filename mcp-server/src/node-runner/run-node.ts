/**
 * Node executor for the workflow poll-runner.
 *
 * Executes the work of a non-SERVER workflow node (a queued pending_execution)
 * locally, on whatever host the runner runs on — the point of CLIENT/EDGE/EXTERNAL
 * execution locations. Scope (MVP): TOOL_REQUEST and RUN_PYTHON, both routed through
 * the SAME `runToolByName` path the platform already uses (TOOL_REQUEST → the named
 * tool; RUN_PYTHON → the `run_python` sandbox tool), so a node runs identically here
 * and on the server. Everything else is rejected as UNSUPPORTED_NODE_TYPE.
 *
 * Throws RunnerError on failure — the poll loop maps that to `complete { error }`,
 * which fails the node. Success returns a JSON-able result for `complete { result }`.
 */
import { runToolByName } from "../mcp/tool-run";

export type RunNodeInput = {
  nodeType: string;
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  instanceId?: string;
  nodeId?: string;
};

export class RunnerError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
  }
}

const RUN_PYTHON_MAX_OUTPUT = 12_000;
const RUN_PYTHON_DEFAULT_TIMEOUT = 120_000;
const RUN_PYTHON_MAX_TIMEOUT = 600_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

// Config may live at the top level or under `standard` (the designer's two idioms),
// mirroring the server executors' cfgValue().
function cfgValue(config: Record<string, unknown>, key: string): unknown {
  const standard = isRecord(config.standard) ? config.standard : {};
  return config[key] ?? standard[key];
}
function cfgString(config: Record<string, unknown>, key: string): string | undefined {
  const v = cfgValue(config, key);
  return typeof v === "string" && v.trim() ? v : undefined;
}
function cfgNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const v = cfgValue(config, key);
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function cfgBool(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = cfgValue(config, key);
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return fallback;
}
function cfgStringArray(config: Record<string, unknown>, key: string): string[] {
  const v = cfgValue(config, key);
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim()) return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}
function parseEnv(config: Record<string, unknown>): Record<string, string> {
  const raw = cfgValue(config, "env");
  if (raw == null || raw === "") return {};
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new RunnerError("VALIDATION", "RUN_PYTHON env must be valid JSON (object of string→string)");
    }
  }
  if (!isRecord(obj)) throw new RunnerError("VALIDATION", "RUN_PYTHON env must be a JSON object");
  const env: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj)) env[k] = String(val);
  return env;
}

export async function runNode(input: RunNodeInput): Promise<{ result: unknown }> {
  const config = isRecord(input.config) ? input.config : {};
  const run_context = {
    runId: input.instanceId,
    workflowInstanceId: input.instanceId,
    nodeId: input.nodeId,
  };

  if (input.nodeType === "TOOL_REQUEST") {
    // Designer stores the tool under toolName (label) or toolId (executor key); the
    // args under inputPayload (server executor) or args. Accept either.
    const tool_name = cfgString(config, "toolName") ?? cfgString(config, "toolId");
    if (!tool_name) throw new RunnerError("VALIDATION", "TOOL_REQUEST node has no toolName/toolId");
    const args = isRecord(config.inputPayload) ? config.inputPayload : isRecord(config.args) ? config.args : {};
    const outcome = await runToolByName({ tool_name, args, run_context });
    if (outcome.toolSuccess === false) {
      throw new RunnerError("TOOL_FAILED", outcome.toolError ?? `tool '${tool_name}' reported failure`);
    }
    return {
      result: {
        tool: tool_name,
        result: outcome.result,
        toolInvocationId: outcome.toolInvocationId,
        durationMs: outcome.durationMs,
      },
    };
  }

  if (input.nodeType === "RUN_PYTHON") {
    const code = cfgString(config, "code");
    if (!code) throw new RunnerError("VALIDATION", "RUN_PYTHON node has no `code` to run");
    const args = {
      code,
      args: cfgStringArray(config, "args"),
      env: parseEnv(config),
      timeout_ms: Math.min(Math.max(cfgNumber(config, "timeoutMs", RUN_PYTHON_DEFAULT_TIMEOUT), 1), RUN_PYTHON_MAX_TIMEOUT),
      allow_network: cfgBool(config, "allowNetwork", false),
      max_output_chars: RUN_PYTHON_MAX_OUTPUT,
    };
    const failOnNonZero = cfgBool(config, "failOnNonZero", true);
    const outcome = await runToolByName({ tool_name: "run_python", args, run_context });
    if (outcome.toolSuccess === false) {
      throw new RunnerError("RUN_PYTHON_FAILED", outcome.toolError ?? "run_python reported failure");
    }
    const receipt = isRecord(outcome.result) ? outcome.result : {};
    const exitCode = typeof receipt.exit_code === "number" ? receipt.exit_code : null;
    const timedOut = receipt.timed_out === true;
    const ok = !failOnNonZero || (exitCode === 0 && !timedOut);
    const payload = {
      runPython: {
        exitCode,
        passed: ok,
        stdout: typeof receipt.stdout_excerpt === "string" ? receipt.stdout_excerpt : "",
        stderr: typeof receipt.stderr_excerpt === "string" ? receipt.stderr_excerpt : "",
        timedOut,
        durationMs: typeof receipt.duration_ms === "number" ? receipt.duration_ms : undefined,
      },
    };
    if (!ok) {
      // Mirror the server: a non-zero exit (with failOnNonZero) is a node failure.
      throw new RunnerError(
        "RUN_PYTHON_NONZERO",
        `run_python ${timedOut ? "timed out" : `exited ${exitCode}`}${payload.runPython.stderr ? `: ${payload.runPython.stderr.slice(0, 300)}` : ""}`,
      );
    }
    return { result: payload };
  }

  throw new RunnerError("UNSUPPORTED_NODE_TYPE", `poll-runner does not execute node type '${input.nodeType}' (supported: TOOL_REQUEST, RUN_PYTHON)`);
}
