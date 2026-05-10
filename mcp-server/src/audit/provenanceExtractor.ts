/**
 * M13 — Code-change provenance extractor.
 *
 * Inspects a tool invocation's output and decides whether it produced a
 * code-change (file write, patch application, git commit, etc). Two paths:
 *
 *   1. Typed envelope — tools that know they touch code can return:
 *        { kind: "code_change",
 *          paths_touched: string[],
 *          diff?: string, patch?: string, commit_sha?: string,
 *          language?: string, lines_added?: number, lines_removed?: number }
 *      Most reliable; preserves whatever the tool wanted to record.
 *
 *   2. Heuristic — for legacy / generic tools, we match on tool name and
 *      best-effort parse the output for common shapes (string → diff,
 *      object with `path|paths|file|files`, etc). Always emits a warning
 *      in `metadata.warnings` so we can audit noisy tools later.
 *
 * Returns null when nothing looks code-change-like — most tool calls.
 */
import type { CodeChangeRecord, CorrelationIds } from "./store";

const HEURISTIC_TOOL_NAMES = new Set<string>([
  "apply_patch", "write_file", "edit_file", "create_file",
  "git_commit", "git_apply", "patch_file",
  // demo / smoke tools — recognised so even if the envelope is dropped,
  // the heuristic still matches.
  "write_file_demo", "apply_patch_demo",
]);

interface ExtractInput {
  tool_name: string;
  args: Record<string, unknown>;
  output: unknown;
  correlation: CorrelationIds & { toolInvocationId?: string };
}

type EnvelopeShape = {
  kind?: string;
  paths_touched?: unknown;
  diff?: unknown;
  patch?: unknown;
  commit_sha?: unknown;
  language?: unknown;
  lines_added?: unknown;
  lines_removed?: unknown;
};

function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  if (typeof v === "string") return [v];
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function fromEnvelope(env: EnvelopeShape): Partial<CodeChangeRecord> | null {
  const paths = asStringArray(env.paths_touched);
  const diff = asString(env.diff);
  const patch = asString(env.patch);
  const sha = asString(env.commit_sha);
  // At least one signal is required to count as a code-change.
  if (!paths && !diff && !patch && !sha) return null;
  return {
    paths_touched: paths ?? [],
    diff, patch, commit_sha: sha,
    language: asString(env.language),
    lines_added: asNumber(env.lines_added),
    lines_removed: asNumber(env.lines_removed),
  };
}

function fromHeuristic(toolName: string, args: Record<string, unknown>, output: unknown): Partial<CodeChangeRecord> | null {
  // Look for common path-bearing fields in args first.
  const argPaths = asStringArray(args.paths) ?? asStringArray(args.files) ?? asStringArray(args.path) ?? asStringArray(args.file);
  // Look for a diff/patch-like blob in output.
  let diff: string | undefined;
  let patch: string | undefined;
  let sha: string | undefined;
  if (typeof output === "string") {
    if (toolName.includes("commit")) sha = output.trim();
    else if (toolName.includes("patch")) patch = output;
    else diff = output;
  } else if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    diff  = asString(o.diff)  ?? asString(o.unified_diff);
    patch = asString(o.patch);
    sha   = asString(o.commit_sha) ?? asString(o.sha);
  }
  if (!argPaths && !diff && !patch && !sha) return null;
  return {
    paths_touched: argPaths ?? [],
    diff, patch, commit_sha: sha,
  };
}

export function extractCodeChange(input: ExtractInput): Omit<CodeChangeRecord, "id" | "timestamp"> | null {
  const { tool_name, args, output, correlation } = input;

  // Path 1 — typed envelope. Output is the envelope itself.
  if (output && typeof output === "object") {
    const env = output as EnvelopeShape;
    if (env.kind === "code_change") {
      const partial = fromEnvelope(env);
      if (partial) {
        return {
          correlation,
          paths_touched: partial.paths_touched ?? [],
          diff: partial.diff,
          patch: partial.patch,
          commit_sha: partial.commit_sha,
          language: partial.language,
          lines_added: partial.lines_added,
          lines_removed: partial.lines_removed,
          tool_name,
          source: "envelope",
        };
      }
    }
  }

  // Path 2 — heuristic on tool name. Only run when the tool name is on
  // the allow-list; otherwise we'd record a code-change for every
  // notify_admin call that happens to return text.
  if (HEURISTIC_TOOL_NAMES.has(tool_name)) {
    const partial = fromHeuristic(tool_name, args, output);
    if (partial) {
      const warnings: string[] = [];
      if ((partial.paths_touched?.length ?? 0) === 0) warnings.push("no-paths-detected");
      if (!partial.diff && !partial.patch && !partial.commit_sha) warnings.push("no-diff-or-commit");
      return {
        correlation,
        paths_touched: partial.paths_touched ?? [],
        diff: partial.diff,
        patch: partial.patch,
        commit_sha: partial.commit_sha,
        tool_name,
        source: "heuristic",
        metadata: warnings.length ? { warnings } : undefined,
      };
    }
  }

  return null;
}
