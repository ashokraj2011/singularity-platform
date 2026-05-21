/**
 * M16 — real fs/git tools (replaces M13 *_demo mocks).
 *
 * Both tools enforce a sandbox root (config.MCP_SANDBOX_ROOT). Paths are
 * resolved relative to the root; absolute paths or `..` traversal that
 * escapes the root are rejected. Tools return the typed `kind:"code_change"`
 * envelope so the existing M13 provenanceExtractor recognises them without
 * any extractor-side changes.
 *
 * write_file: creates/overwrites a file under the sandbox with a complete
 *   replacement body. It rejects unified diff-looking content for existing
 *   files; use apply_patch / anchor edit tools for partial edits.
 * git_commit: stages all changes under the sandbox + commits with the given
 *   message. Returns paths_touched + commit_sha + actual git diff.
 *
 * Both are MEDIUM risk, no approval (operator can wrap them in an APPROVAL
 * node at the workflow layer if needed).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { ToolHandler } from "./registry";
import { resolveSandboxedPath, sandboxRoot } from "../workspace/sandbox";
import { indexChangedFiles, indexWorkspace } from "../workspace/ast-index";
import { ensureGitRepo } from "../workspace/git-workspace";

const execFileP = promisify(execFile);
const FULL_REPLACE_SOFT_LIMIT_BYTES = 64_000;

function unifiedDiffForNewFile(relPath: string, content: string): string {
  const lines = content.split("\n");
  const body = lines.map((l) => `+${l}`).join("\n");
  return `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

function looksLikeUnifiedDiff(content: string): boolean {
  const trimmed = content.trimStart();
  return /^(diff --git |---\s+a\/|\+\+\+\s+b\/|@@\s+-)/.test(trimmed);
}

function countChangedLines(patch: string, prefix: "+" | "-"): number {
  return patch
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .length;
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}

async function codeChangeOutputForFile(
  rel: string,
  fallbackPatch: string,
  linesAdded: number,
  linesRemoved: number,
  tool: string,
): Promise<Record<string, unknown>> {
  await indexChangedFiles([rel], tool);
  const realDiff = await gitDiffForPath(rel);
  const patch = realDiff ?? fallbackPatch;
  return {
    kind: "code_change",
    paths_touched: [rel],
    diff: patch,
    patch,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
  };
}

async function gitDiffForPath(relPath: string): Promise<string | null> {
  try {
    const cwd = sandboxRoot();
    await ensureGitRepo();
    const { stdout } = await execFileP("git", ["diff", "--", relPath], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim() ? stdout : null;
  } catch {
    return null;
  }
}

function normalizePatchPath(raw: string): string | null {
  const token = raw.trim().replace(/^"|"$/g, "").split(/\s+/)[0] ?? "";
  if (!token || token === "/dev/null") return null;
  let rel = token;
  if (rel.startsWith("a/") || rel.startsWith("b/")) rel = rel.slice(2);
    if (
      rel.startsWith("/") ||
      rel.startsWith("\\") ||
    rel.includes("\\") ||
    rel.split("/").some((part) => part === "..")
  ) {
    throw new Error(`patch path escapes the sandbox: ${token}`);
  }
  resolveSandboxedPath(rel);
  return rel;
}

function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  let hasHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@ ")) hasHunk = true;
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git\s+(.+?)\s+(.+)$/);
      if (!match) throw new Error(`malformed diff header: ${line}`);
      for (const rawPath of [match[1], match[2]]) {
        const rel = normalizePatchPath(rawPath);
        if (rel) paths.add(rel);
      }
      continue;
    }
    if (/^(rename|copy)\s+(from|to)\s+/.test(line)) {
      const rel = normalizePatchPath(line.replace(/^(rename|copy)\s+(from|to)\s+/, ""));
      if (rel) paths.add(rel);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const rel = normalizePatchPath(line.slice(4));
      if (rel) paths.add(rel);
    }
  }
  if (!hasHunk || paths.size === 0) {
    throw new Error("patch must be a unified diff with at least one file path and hunk");
  }
  return Array.from(paths);
}

/**
 * M47.B — Pre-flight check on unified-diff hunk arithmetic. Returns a
 * human-readable problem description if it finds one, or null if the
 * arithmetic is internally consistent. This catches the most common
 * "corrupt patch" cause: the @@ -A,B +C,D @@ line counts don't match
 * the actual hunk body. git apply's error for this is unhelpfully
 * vague; surfacing the specific count mismatch lets the LLM self-correct.
 *
 * Exported for testability.
 */
export function validatePatchHunkArithmetic(patch: string): string | null {
  const lines = patch.split(/\r?\n/);
  // Hunk header: @@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@ optional-context
  const headerRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(headerRe);
    if (!m) { i++; continue; }
    const declaredOldCount = m[2] === undefined ? 1 : Number(m[2]);
    const declaredNewCount = m[4] === undefined ? 1 : Number(m[4]);
    // Walk forward until the next hunk header / file header / end-of-patch.
    let oldSeen = 0, newSeen = 0;
    let j = i + 1;
    while (j < lines.length) {
      const body = lines[j];
      if (body.startsWith("@@ ") || body.startsWith("--- ") || body.startsWith("+++ ") || body.startsWith("diff --git ")) break;
      if (body.startsWith("+")) newSeen++;
      else if (body.startsWith("-")) oldSeen++;
      else if (body.startsWith(" ")) { oldSeen++; newSeen++; }
      // Unified-diff context lines start with a literal space. An empty
      // string in the split output is the file's trailing newline (or a
      // blank-line break between sections), never a real context line.
      // Other prefixes (e.g. `\ No newline at end of file`) are ignored.
      j++;
    }
    if (oldSeen !== declaredOldCount) {
      return `hunk header "${line}" declares ${declaredOldCount} source-side line(s) but the hunk body has ${oldSeen} context+removal line(s)`;
    }
    if (newSeen !== declaredNewCount) {
      return `hunk header "${line}" declares ${declaredNewCount} destination-side line(s) but the hunk body has ${newSeen} context+addition line(s)`;
    }
    i = j;
  }
  return null;
}

/** M47.B — Translate opaque `git apply` errors into actionable hints. */
function enrichGitApplyError(raw: string, patch: string): string {
  const trimmed = raw.trim();
  // The most useful intel is "error: corrupt patch at line N". Try to
  // surface the lines around N from the patch so the model can see what
  // git tripped on.
  const m = trimmed.match(/corrupt patch at line (\d+)/i);
  if (m) {
    const target = Number(m[1]);
    const lines = patch.split(/\r?\n/);
    const start = Math.max(0, target - 3);
    const end = Math.min(lines.length, target + 2);
    const snippet = lines.slice(start, end).map((l, idx) => `  ${start + idx + 1}: ${l}`).join("\n");
    return `apply_patch: ${trimmed}\n\nContext (patch lines ${start + 1}-${end}):\n${snippet}\n\nThis is usually a hunk-header arithmetic error (@@ counts don't match the body), an off-by-one anchor, or a stale file. Re-read the file and either fix the @@ counts, OR switch to replace_range/replace_text (no hunk arithmetic required).`;
  }
  if (/does not (apply|match)/i.test(trimmed)) {
    return `apply_patch: ${trimmed}\n\nThe patch's context lines don't match what's currently in the file. Likely causes: (1) file was modified between read and patch, (2) you're patching against a stale snapshot, (3) whitespace mismatch. Re-read the file with read_file and rebuild the patch.`;
  }
  return `apply_patch: ${trimmed}`;
}

async function gitApply(args: string[], patch: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["apply", ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error((stderr || `git apply exited ${code}`).trim()));
    });
    child.stdin.end(patch);
  });
}

export const writeFileTool: ToolHandler = {
  descriptor: {
    name: "write_file",
    description: "Create or overwrite a file under the MCP sandbox root with complete file contents, not a diff.",
    natural_language:
      "Use this when the user asks to write or overwrite a complete file body at a given path. For unified diffs or partial edits, use apply_patch instead.",
    input_schema: {
      type: "object",
      properties: {
        path:    { type: "string", description: "Sandbox-relative file path" },
        content: { type: "string", description: "Complete new file body. Do not pass unified diff text here. Must be non-empty unless allowEmpty=true." },
        forceFullReplace: { type: "boolean", description: "Set true only when deliberately replacing a large existing file body." },
        expected_hash: { type: "string", description: "SHA-256 content_hash from last read_file. Required for intentional overwrites. CONFLICT if stale." },
        expected_absent: { type: "boolean", description: "Set true when creating a new file. Fails if file already exists." },
        allowEmpty: { type: "boolean", description: "Set true only if you deliberately want to create a zero-byte file. Defaults to false so truncated content args are caught instead of silently producing empty files." },
      },
      required: ["path", "content"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const rel = String(args.path ?? "");
      const content = String(args.content ?? "");
      // Reject empty content unless the agent explicitly opts in. When the
      // model output is truncated mid-emit (e.g. hits maxOutputTokens before
      // the JSON closes), the parsed tool call arrives with content="" and
      // the file is silently created empty. The agent then sees an empty
      // file, retries the same call, and trips agent_loop_repetition. Fail
      // loudly so the LLM can self-correct (shorten the file, split into
      // multiple write_files, or use apply_patch for an incremental edit).
      if (content.length === 0 && args.allowEmpty !== true) {
        return {
          success: false,
          output: null,
          error_code: "VALIDATION",
          error: "write_file refused: content is empty. Common cause: your previous output was truncated by maxOutputTokens before the content arg finished streaming. Either (a) shorten the file body and retry, (b) emit the file in two halves via write_file then apply_patch, or (c) pass allowEmpty=true if you genuinely want a zero-byte file.",
        };
      }
      const abs = resolveSandboxedPath(rel);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      const existed = fs.existsSync(abs);
      const prevContent = existed ? await fs.promises.readFile(abs, "utf8") : "";
      if (args.expected_absent === true && existed) {
        return {
          success: false,
          output: { existing_bytes: prevContent.length },
          error_code: "CONFLICT",
          error: `CONFLICT: expected file to not exist, but ${rel} already exists.`,
        };
      }
      if (existed && args.expected_hash) {
        const currentHash = createHash("sha256").update(prevContent).digest("hex");
        if (currentHash !== String(args.expected_hash)) {
          return {
            success: false,
            output: { current_hash: currentHash },
            error_code: "CONFLICT",
            error: `CONFLICT: file modified since last read. Expected hash ${args.expected_hash}, got ${currentHash}.`,
          };
        }
      }
      if (existed && looksLikeUnifiedDiff(content)) {
        return {
          success: false,
          output: null,
          error_code: "VALIDATION",
          error: "write_file requires complete file contents, not a unified diff. Use apply_patch for partial edits.",
        };
      }
      if (
        existed &&
        args.forceFullReplace !== true &&
        prevContent.length >= FULL_REPLACE_SOFT_LIMIT_BYTES &&
        content.length >= FULL_REPLACE_SOFT_LIMIT_BYTES
      ) {
        return {
          success: false,
          output: null,
          error_code: "VALIDATION",
          error: `write_file would replace a large existing file (${prevContent.length} bytes). Use apply_patch for partial edits, or pass forceFullReplace=true for an intentional full-body replacement.`,
        };
      }
      await fs.promises.writeFile(abs, content, "utf8");
      await indexChangedFiles([rel], "write_file");
      const realDiff = existed ? await gitDiffForPath(rel) : null;
      const diff = realDiff ?? (existed
        ? `--- a/${rel}\n+++ b/${rel}\n@@ ${prevContent.split("\n").length} -> ${content.split("\n").length} @@\n${prevContent.split("\n").map((l) => `-${l}`).join("\n")}\n${content.split("\n").map((l) => `+${l}`).join("\n")}\n`
        : unifiedDiffForNewFile(rel, content));
      return {
        success: true,
        output: {
          kind: "code_change",
          paths_touched: [rel],
          diff,
          lines_added: content.split("\n").length,
          lines_removed: existed ? prevContent.split("\n").length : 0,
        },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

export const applyPatchTool: ToolHandler = {
  descriptor: {
    name: "apply_patch",
    description: "Apply a unified diff patch inside the MCP sandbox root.",
    natural_language:
      "Use this for partial file edits expressed as a unified diff. The patch is validated with git apply --check before it is applied.",
    input_schema: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Unified diff patch text" },
        expected_hashes: {
          type: "object",
          description: "Map of sandbox-relative path -> SHA-256 content_hash. Each existing file in the patch is checked.",
          additionalProperties: { type: "string" },
        },
        expected_absent_paths: {
          type: "array",
          items: { type: "string" },
          description: "Paths expected to not exist (new files created by the patch). CONFLICT if any already exist.",
        },
      },
      required: ["patch"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const patch = String(args.patch ?? "");
      if (!patch.trim()) return { success: false, output: null, error_code: "VALIDATION", error: "patch is required" };
      const paths = extractPatchPaths(patch);

      // Check existing files for hash staleness
      if (args.expected_hashes && typeof args.expected_hashes === "object") {
        const hashMap = args.expected_hashes as Record<string, string>;
        for (const filePath of paths) {
          if (!hashMap[filePath]) continue;
          const abs = resolveSandboxedPath(filePath);
          if (!fs.existsSync(abs)) continue;
          const currentContent = await fs.promises.readFile(abs, "utf8");
          const currentHash = createHash("sha256").update(currentContent).digest("hex");
          if (currentHash !== hashMap[filePath]) {
            return {
              success: false,
              output: { stale_path: filePath, current_hash: currentHash },
              error_code: "CONFLICT",
              error: `CONFLICT: ${filePath} modified since last read. Expected ${hashMap[filePath]}, got ${currentHash}.`,
            };
          }
        }
      }

      // Check new-file paths don't already exist
      if (Array.isArray(args.expected_absent_paths)) {
        for (const absPath of args.expected_absent_paths) {
          const rel = String(absPath);
          const abs = resolveSandboxedPath(rel);
          if (fs.existsSync(abs)) {
            return {
              success: false,
              output: { existing_path: rel },
              error_code: "CONFLICT",
              error: `CONFLICT: Patch creates ${rel}, but file already exists.`,
            };
          }
        }
      }

      // M47.B — Pre-validate hunk-header arithmetic before handing to
      // `git apply`. The "corrupt patch at line N" error from git is too
      // opaque for the LLM to self-correct; surface the specific issue
      // (e.g. "hunk @@ -192,4 +192,164 @@ declares 4 source lines but the
      // hunk body has 6 context/removal lines").
      const hunkIssue = validatePatchHunkArithmetic(patch);
      if (hunkIssue) {
        return {
          success: false, output: null, error_code: "VALIDATION",
          error: `apply_patch: ${hunkIssue}. Re-read the file with read_file or get_ast_slice, then either (a) re-emit the patch with corrected @@ counts, or (b) use replace_range/replace_text for the same edit (no hunk arithmetic).`,
        };
      }

      const cwd = sandboxRoot();
      await ensureGitRepo();
      try {
        await gitApply(["--check"], patch, cwd);
      } catch (err) {
        const raw = (err as Error).message;
        return {
          success: false, output: null, error_code: "VALIDATION",
          error: enrichGitApplyError(raw, patch),
        };
      }
      await gitApply([], patch, cwd);
      await indexChangedFiles(paths, "apply_patch");
      return {
        success: true,
        output: {
          kind: "code_change",
          paths_touched: paths,
          patch,
          lines_added: countChangedLines(patch, "+"),
          lines_removed: countChangedLines(patch, "-"),
        },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

export const replaceTextTool: ToolHandler = {
  descriptor: {
    name: "replace_text",
    description: "Replace exact text inside an existing sandboxed file after validating the anchor text is present.",
    natural_language:
      "Use this for small anchored edits when you know the exact text to replace. It validates oldText before writing and fails without changing the file when the anchor is missing or ambiguous.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Sandbox-relative file path" },
        oldText: { type: "string", description: "Exact existing text to replace" },
        newText: { type: "string", description: "Replacement text" },
        occurrence: {
          oneOf: [{ type: "string", enum: ["first", "all"] }, { type: "number" }],
          description: "Which occurrence to replace. Defaults to first. Number is 1-based.",
        },
        expected_hash: {
          type: "string",
          description: "SHA-256 content_hash from last read_file. CONFLICT if current file hash differs.",
        },
        expected_replacements: {
          type: "number",
          description: "Required when occurrence='all'. Expected match count. CONFLICT if actual differs.",
        },
      },
      required: ["path", "oldText", "newText"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const rel = String(args.path ?? "");
      const oldText = String(args.oldText ?? "");
      const newText = String(args.newText ?? "");
      if (!oldText) return { success: false, output: null, error_code: "VALIDATION", error: "oldText is required" };

      // M46.B — Arity guard. The "lazy-edit + broke-unrelated-tests" failure
      // mode was: model anchors on a SHORT oldText (often a closing brace
      // near end-of-file) and supplies a LONG newText that adds many lines.
      // The replacement smashes the small anchor + everything implicitly
      // after it, destroying trailing content the model didn't realize was
      // there. Block when the ratio is wildly off and point the model at
      // apply_patch (which uses explicit context lines) or a narrower edit.
      const oldLines = oldText.split("\n").length;
      const newLines = newText.split("\n").length;
      const linesAdded = Math.max(0, newLines - oldLines);
      const linesRemoved = Math.max(0, oldLines - newLines);
      if (linesAdded > 100 && oldLines < 10) {
        return {
          success: false,
          output: null,
          error_code: "VALIDATION",
          error:
            `replace_text arity guard: oldText is ${oldLines} line(s) but newText adds ${linesAdded} new line(s). ` +
            `This shape destroys trailing content under the anchor — the model is usually unaware of what came after. ` +
            `Use apply_patch (with explicit context lines around the insertion point) for large additions, ` +
            `or split this into two surgical replace_text calls: (1) modify just the matching region, ` +
            `(2) write_file a NEW file for the bulk of the new content. ` +
            `Limits: replace_text rejects when newLines − oldLines > 100 AND oldLines < 10.`,
        };
      }
      // Soft warning for moderate cases — these often work but are risky.
      // We include the warning in the output so the model can self-correct
      // on the next call without blocking the current edit.
      const arityWarning = (linesAdded > 50 && oldLines < 5)
        ? `replace_text arity warning: oldText ${oldLines}L, newText adds ${linesAdded}L. Prefer apply_patch for safer multi-line additions.`
        : undefined;
      void linesRemoved; // currently unused; reserved for future heuristics

      const abs = resolveSandboxedPath(rel);
      const prevContent = await fs.promises.readFile(abs, "utf8");
      if (args.expected_hash) {
        const currentHash = createHash("sha256").update(prevContent).digest("hex");
        if (currentHash !== String(args.expected_hash)) {
          return {
            success: false,
            output: { current_hash: currentHash },
            error_code: "CONFLICT",
            error: `CONFLICT: file modified since last read. Expected hash ${args.expected_hash}, got ${currentHash}.`,
          };
        }
      }
      const matches = [...prevContent.matchAll(new RegExp(oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
      if (matches.length === 0) {
        return {
          success: false,
          output: null,
          error_code: "CONFLICT",
          error: "replace_text conflict: oldText was not found; file was not changed",
        };
      }

      const occurrence = args.occurrence ?? "first";
      let content: string;
      let replaced = 0;
      if (occurrence === "all") {
        if (typeof args.expected_replacements !== "number") {
          return {
            success: false,
            output: null,
            error_code: "VALIDATION",
            error: "replace_text with occurrence='all' requires expected_replacements count",
          };
        }
        if (matches.length !== args.expected_replacements) {
          return {
            success: false,
            output: { actual_count: matches.length },
            error_code: "CONFLICT",
            error: `CONFLICT: expected ${args.expected_replacements} occurrence(s) of oldText, found ${matches.length}.`,
          };
        }
        content = prevContent.split(oldText).join(newText);
        replaced = matches.length;
      } else {
        const requested = typeof occurrence === "number" ? Math.floor(occurrence) : 1;
        if (requested < 1) throw new Error("replace_text occurrence number must be 1-based");
        if (requested > matches.length) {
          throw new Error(`replace_text conflict: occurrence ${requested} was not found; only ${matches.length} match(es) exist`);
        }
        const match = matches[requested - 1];
        const index = match.index;
        if (index === undefined) throw new Error("replace_text conflict: unable to locate occurrence");
        content = prevContent.slice(0, index) + newText + prevContent.slice(index + oldText.length);
        replaced = 1;
      }

      await fs.promises.writeFile(abs, content, "utf8");
      const fallbackPatch = `--- a/${rel}\n+++ b/${rel}\n@@ replace_text ${replaced} occurrence(s) @@\n-${oldText}\n+${newText}\n`;
      const codeChange = await codeChangeOutputForFile(
        rel,
        fallbackPatch,
        lineCount(newText) * replaced,
        lineCount(oldText) * replaced,
        "replace_text",
      );
      // M46.B — attach the arity warning to the output when it triggered so
      // the LLM sees the advisory in its tool_result on the next turn.
      const finalOutput = arityWarning ? { ...codeChange, arity_warning: arityWarning } : codeChange;
      return { success: true, output: finalOutput };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

export const replaceRangeTool: ToolHandler = {
  descriptor: {
    name: "replace_range",
    description: "Replace an inclusive 1-based line range inside an existing sandboxed file.",
    natural_language:
      "Use this for anchored line-range edits after inspecting the file. It validates the range before writing and fails without changing the file when the range is invalid.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Sandbox-relative file path" },
        startLine: { type: "number", description: "1-based inclusive start line" },
        endLine: { type: "number", description: "1-based inclusive end line" },
        replacement: { type: "string", description: "Replacement text for the selected line range" },
        expected_hash: { type: "string", description: "SHA-256 content_hash from last read_file. CONFLICT if stale." },
      },
      required: ["path", "startLine", "endLine", "replacement"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const rel = String(args.path ?? "");
      const startLine = Math.floor(Number(args.startLine));
      const endLine = Math.floor(Number(args.endLine));
      const replacement = String(args.replacement ?? "");
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) {
        return {
          success: false,
          output: null,
          error_code: "VALIDATION",
          error: "replace_range requires a valid 1-based inclusive startLine/endLine range",
        };
      }
      const abs = resolveSandboxedPath(rel);
      const prevContent = await fs.promises.readFile(abs, "utf8");
      if (args.expected_hash) {
        const currentHash = createHash("sha256").update(prevContent).digest("hex");
        if (currentHash !== String(args.expected_hash)) {
          return {
            success: false,
            output: { current_hash: currentHash },
            error_code: "CONFLICT",
            error: `CONFLICT: file modified since last read. Expected hash ${args.expected_hash}, got ${currentHash}.`,
          };
        }
      }
      const hadTrailingNewline = prevContent.endsWith("\n");
      const lines = prevContent.split("\n");
      if (hadTrailingNewline) lines.pop();
      if (endLine > lines.length) {
        throw new Error(`replace_range conflict: requested line ${endLine}, but file has ${lines.length} line(s); file was not changed`);
      }
      const replacementLines = replacement.length === 0 ? [] : replacement.replace(/\n$/, "").split("\n");
      const removedLines = lines.slice(startLine - 1, endLine);
      const nextLines = [
        ...lines.slice(0, startLine - 1),
        ...replacementLines,
        ...lines.slice(endLine),
      ];
      const content = nextLines.join("\n") + (hadTrailingNewline ? "\n" : "");
      await fs.promises.writeFile(abs, content, "utf8");
      const fallbackPatch = [
        `--- a/${rel}`,
        `+++ b/${rel}`,
        `@@ replace_range ${startLine},${endLine} @@`,
        ...removedLines.map((line) => `-${line}`),
        ...replacementLines.map((line) => `+${line}`),
        "",
      ].join("\n");
      return {
        success: true,
        output: await codeChangeOutputForFile(
          rel,
          fallbackPatch,
          replacementLines.length,
          removedLines.length,
          "replace_range",
        ),
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

export const gitCommitTool: ToolHandler = {
  descriptor: {
    name: "git_commit",
    description: "Stage all dirty files under the sandbox and commit with the given message.",
    natural_language:
      "Use this after write_file to record the change as a git commit. Provide a clear commit message.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message" },
        author:  { type: "string", description: "Optional author 'Name <email>'" },
      },
      required: ["message"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    const cwd = sandboxRoot();
    const message = String(args.message ?? "");
    if (!message) return { success: false, output: null, error: "commit message is required" };
    try {
      // Init the repo lazily so first-run doesn't require manual setup. No-op
      // on an existing repo because git init is idempotent.
      await ensureGitRepo();
      // Diff BEFORE staging so we can include it in the envelope.
      const { stdout: pathsRaw } = await execFileP("git", ["diff", "--name-only"], { cwd });
      const { stdout: untrackedRaw } = await execFileP("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
      const paths = [...pathsRaw.split("\n"), ...untrackedRaw.split("\n")]
        .map((s) => s.trim()).filter(Boolean);
      if (paths.length === 0) {
        return { success: false, output: null, error: "no changes to commit" };
      }
      await execFileP("git", ["add", "-A"], { cwd });
      const author = typeof args.author === "string" && args.author.includes("<")
        ? ["--author", args.author] : [];
      await execFileP("git", ["commit", "-m", message, ...author], { cwd, maxBuffer: 10 * 1024 * 1024 });
      const { stdout: shaRaw } = await execFileP("git", ["rev-parse", "HEAD"], { cwd });
      const sha = shaRaw.trim();
      const { stdout: diffRaw } = await execFileP("git", ["show", "--format=", sha], {
        cwd, maxBuffer: 10 * 1024 * 1024,
      });
      await indexWorkspace("git_commit");
      return {
        success: true,
        output: {
          kind: "code_change",
          paths_touched: paths,
          commit_sha: sha,
          patch: diffRaw,
        },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};
