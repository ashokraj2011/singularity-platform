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
        content: { type: "string", description: "Complete new file body. Do not pass unified diff text here." },
        forceFullReplace: { type: "boolean", description: "Set true only when deliberately replacing a large existing file body." },
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
      const abs = resolveSandboxedPath(rel);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      const existed = fs.existsSync(abs);
      const prevContent = existed ? await fs.promises.readFile(abs, "utf8") : "";
      if (existed && looksLikeUnifiedDiff(content)) {
        throw new Error("write_file requires complete file contents, not a unified diff. Use apply_patch for partial edits.");
      }
      if (
        existed &&
        args.forceFullReplace !== true &&
        prevContent.length >= FULL_REPLACE_SOFT_LIMIT_BYTES &&
        content.length >= FULL_REPLACE_SOFT_LIMIT_BYTES
      ) {
        throw new Error(
          `write_file would replace a large existing file (${prevContent.length} bytes). Use apply_patch for partial edits, or pass forceFullReplace=true for an intentional full-body replacement.`,
        );
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
      },
      required: ["patch"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const patch = String(args.patch ?? "");
      if (!patch.trim()) throw new Error("patch is required");
      const paths = extractPatchPaths(patch);
      const cwd = sandboxRoot();
      await ensureGitRepo();
      await gitApply(["--check"], patch, cwd);
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
      if (!oldText) throw new Error("oldText is required");
      const abs = resolveSandboxedPath(rel);
      const prevContent = await fs.promises.readFile(abs, "utf8");
      const matches = [...prevContent.matchAll(new RegExp(oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
      if (matches.length === 0) throw new Error("replace_text conflict: oldText was not found; file was not changed");

      const occurrence = args.occurrence ?? "first";
      let content: string;
      let replaced = 0;
      if (occurrence === "all") {
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
      return {
        success: true,
        output: await codeChangeOutputForFile(
          rel,
          fallbackPatch,
          lineCount(newText) * replaced,
          lineCount(oldText) * replaced,
          "replace_text",
        ),
      };
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
        throw new Error("replace_range requires a valid 1-based inclusive startLine/endLine range");
      }
      const abs = resolveSandboxedPath(rel);
      const prevContent = await fs.promises.readFile(abs, "utf8");
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
