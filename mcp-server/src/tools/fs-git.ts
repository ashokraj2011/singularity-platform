/**
 * M16 — real fs/git tools (replaces M13 *_demo mocks).
 *
 * Both tools enforce a sandbox root (config.MCP_SANDBOX_ROOT). Paths are
 * resolved relative to the root; absolute paths or `..` traversal that
 * escapes the root are rejected. Tools return the typed `kind:"code_change"`
 * envelope so the existing M13 provenanceExtractor recognises them without
 * any extractor-side changes.
 *
 * write_file: creates/overwrites a file under the sandbox. Returns paths +
 *   diff (synthesised from the new content; for a real git diff use git_commit
 *   afterwards).
 * git_commit: stages all changes under the sandbox + commits with the given
 *   message. Returns paths_touched + commit_sha + actual git diff.
 *
 * Both are MEDIUM risk, no approval (operator can wrap them in an APPROVAL
 * node at the workflow layer if needed).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolHandler } from "./registry";
import { resolveSandboxedPath, sandboxRoot } from "../workspace/sandbox";
import { indexChangedFiles, indexWorkspace } from "../workspace/ast-index";
import { ensureGitRepo } from "../workspace/git-workspace";

const execFileP = promisify(execFile);

function unifiedDiffForNewFile(relPath: string, content: string): string {
  const lines = content.split("\n");
  const body = lines.map((l) => `+${l}`).join("\n");
  return `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

export const writeFileTool: ToolHandler = {
  descriptor: {
    name: "write_file",
    description: "Create or overwrite a file under the MCP sandbox root.",
    natural_language:
      "Use this when the user asks to write or overwrite a file at a given path.",
    input_schema: {
      type: "object",
      properties: {
        path:    { type: "string", description: "Sandbox-relative file path" },
        content: { type: "string", description: "New file body" },
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
      await fs.promises.writeFile(abs, content, "utf8");
      await indexChangedFiles([rel], "write_file");
      const diff = existed
        // Existing-file diff is synthetic (line-by-line replacement). For a
        // real diff, follow with git_commit.
        ? `--- a/${rel}\n+++ b/${rel}\n@@ ${prevContent.split("\n").length} -> ${content.split("\n").length} @@\n${prevContent.split("\n").map((l) => `-${l}`).join("\n")}\n${content.split("\n").map((l) => `+${l}`).join("\n")}\n`
        : unifiedDiffForNewFile(rel, content);
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
