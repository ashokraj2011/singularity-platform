/**
 * M42.8 — Token-efficient discovery tools that replace OS-specific commands.
 *
 * Agents (Sonnet especially) reach for `find`, `cat`, `wc`, `grep` because
 * those are universal CLI verbs. None are in the runner allowlist (security
 * + portability), and even if they were, they're token-wasteful: `cat` ships
 * the whole file when a slice would do, `find` doesn't filter sandbox-skip
 * dirs, `wc -l` requires reading the whole file just to count lines.
 *
 * This module gives MCP-native equivalents:
 *
 *   OS verb              MCP replacement                   Why it's better
 *   ─────────────────    ───────────────────────────────   ─────────────────────────
 *   cat <file>           read_file (already exists)        Sandbox-scoped, hash-aware
 *   find -name <glob>    find_files                        Skips node_modules/.git/etc; paths-only
 *   grep <pattern>       search_code (already exists)      Ripgrep under the hood + can add context
 *   grep -A 30 / -B 10   search_code w/ context_before/after  Now wired in this module
 *   ls / ls -la          list_directory (already exists)   Sandbox-scoped, recursive opt
 *   wc -l <file>         file_stats                        Bytes + lines + language hint
 *
 * All tools here are LOW risk, read-only, sandbox-anchored.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSandboxedPath, sandboxRoot } from "../workspace/sandbox";
import { globToRegex, toPosixPath } from "../workspace/glob";
import type { ToolHandler } from "./registry";
import { config } from "../config";

const execFileP = promisify(execFile);
const RG_SEARCH_TIMEOUT_MS = config.MCP_RG_SEARCH_TIMEOUT_MS;

// Sandbox-skip set. Aligned with list_directory's SKIP_DIRS in core.ts.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "__pycache__", ".venv", "venv",
  ".next", ".turbo", ".cache", "coverage", "target",
]);

// Common language map for file_stats. Cheap to compute; lets the model pick
// the right verifier without an extra round-trip.
const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".java": "java", ".kt": "kotlin", ".scala": "scala",
  ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php",
  ".cs": "csharp", ".cpp": "cpp", ".cc": "cpp", ".c": "c", ".h": "c",
  ".md": "markdown", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
  ".xml": "xml", ".html": "html", ".css": "css", ".sh": "shell",
  ".sql": "sql", ".toml": "toml",
};

// ── find_files — replaces `find -name <glob>` ──────────────────────────────

export const findFilesTool: ToolHandler = {
  descriptor: {
    name: "find_files",
    description:
      "FALLBACK file-enumeration tool. PREFER list_indexed_files when the workspace " +
      "has been indexed (it queries the AST index — sub-millisecond, language-tagged, " +
      "no filesystem walk). Use find_files only for non-indexable files (README, *.yml, " +
      "*.properties, *.txt) or BEFORE the first index_workspace call. Skips " +
      "node_modules/.git/dist/build/target/etc. NEVER call run_command('find',...) — " +
      "the runner rejects `find` and even if it didn't, this tool returns half the tokens.",
    natural_language:
      "Use only when list_indexed_files can't help — e.g. searching for README, *.yml, " +
      "config files, or before the workspace has been indexed. For code files (*.java, " +
      "*.ts, *.py, *.go) after PLAN_DRAFT's index_workspace, prefer list_indexed_files.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob to match (e.g. '*.java', '**/*Test*.kt', 'src/**/*Service*.java'). " +
            "Matched against each file's path relative to the sandbox root.",
        },
        path: {
          type: "string",
          description: "Sandbox-relative subdirectory to search within. Default: '.'",
        },
        max_results: {
          type: "number",
          description: "Cap the number of paths returned. Default 100, max 1000.",
        },
        include_dirs: {
          type: "boolean",
          description: "Include directory entries in addition to files. Default false.",
        },
      },
      required: ["pattern"],
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const pattern = String(args.pattern ?? "").trim();
      if (!pattern) throw new Error("pattern is required");
      const rel = typeof args.path === "string" && args.path.trim() ? String(args.path) : ".";
      const max = clamp(args.max_results, 100, 1, 1000);
      const includeDirs = Boolean(args.include_dirs);

      const root = sandboxRoot();
      const start = rel === "." ? root : resolveSandboxedPath(rel);
      const matcher = globToRegex(pattern);
      const out: Array<{ path: string; type: "file" | "dir"; size?: number; mtime?: string }> = [];

      async function walk(dir: string): Promise<void> {
        if (out.length >= max) return;
        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          if (out.length >= max) return;
          if (SKIP_DIRS.has(ent.name)) continue;
          const full = path.join(dir, ent.name);
          const relPath = toPosixPath(path.relative(root, full), path.sep);
          if (ent.isDirectory()) {
            if (includeDirs && matcher.test(relPath)) {
              out.push({ path: relPath, type: "dir" });
            }
            await walk(full);
          } else if (ent.isFile()) {
            if (matcher.test(relPath) || matcher.test(ent.name)) {
              const st = await fs.promises.stat(full).catch(() => null);
              out.push({
                path: relPath,
                type: "file",
                size: st?.size,
                mtime: st?.mtime?.toISOString(),
              });
            }
          }
        }
      }
      await walk(start);

      return {
        success: true,
        output: {
          pattern,
          scope: rel,
          count: out.length,
          truncated: out.length >= max,
          files: out,
        },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

// ── file_stats — replaces `wc -l` and quick `stat` ────────────────────────

export const fileStatsTool: ToolHandler = {
  descriptor: {
    name: "file_stats",
    description:
      "FALLBACK file-metadata tool. PREFER list_indexed_files which returns size + " +
      "language for every indexed file in one call. Use file_stats only for non-indexed " +
      "files (README, yaml, properties) or when you need a FRESH size after an edit that " +
      "hasn't been re-indexed. Counts lines accurately (handles \\r\\n line endings). " +
      "NEVER call run_command('wc',...).",
    natural_language:
      "Use only for non-indexable files or to verify size/lines after an edit. For " +
      "code-file sizing pre-read, list_indexed_files already gives you size + language.",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Sandbox-relative file paths. Up to 50 per call.",
        },
        path: {
          type: "string",
          description: "Convenience alias when checking a single file.",
        },
      },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const inputs: string[] = [];
      if (Array.isArray(args.paths)) {
        for (const p of args.paths) if (typeof p === "string") inputs.push(p);
      }
      if (typeof args.path === "string" && args.path.trim()) inputs.push(args.path);
      if (inputs.length === 0) throw new Error("paths or path is required");
      if (inputs.length > 50) throw new Error("up to 50 paths per call");

      const stats = await Promise.all(
        inputs.map(async (p) => {
          try {
            const abs = resolveSandboxedPath(p);
            const st = await fs.promises.stat(abs);
            if (!st.isFile()) {
              return { path: p, exists: false, reason: "not a regular file" };
            }
            // Stream line count without slurping into memory for huge files.
            // Capped at 50MB by default to avoid pathological inputs.
            let lines = 0;
            if (st.size <= 50 * 1024 * 1024) {
              const content = await fs.promises.readFile(abs, "utf8");
              for (const ch of content) if (ch === "\n") lines += 1;
              if (content.length > 0 && !content.endsWith("\n")) lines += 1;
            }
            const ext = path.extname(p).toLowerCase();
            return {
              path: p,
              exists: true,
              bytes: st.size,
              lines: st.size <= 50 * 1024 * 1024 ? lines : undefined,
              language: LANGUAGE_BY_EXT[ext] ?? undefined,
              mtime: st.mtime.toISOString(),
            };
          } catch (err) {
            return { path: p, exists: false, reason: (err as Error).message };
          }
        }),
      );

      return { success: true, output: { count: stats.length, stats } };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

// ── grep_lines — search_code with context lines (grep -A/-B equivalent) ───
// This is a separate tool (rather than extending search_code's args) so the
// model has a verb that matches its mental model of "grep with context".
// Both tools share the underlying ripgrep call.

export const grepLinesTool: ToolHandler = {
  descriptor: {
    name: "grep_lines",
    description:
      "Like search_code but returns N context lines BEFORE and AFTER each match. " +
      "Equivalent to `grep -B N -A M` but sandbox-scoped, ripgrep-backed, and " +
      "skips heavy dirs. Use when you need surrounding code context (e.g. the case " +
      "block around `case contains:`), not just the matching line.",
    natural_language:
      "Use this instead of `grep -A 30 'case X:' <file>` when you need to see what " +
      "comes around a match. For pure 'does this exist' lookups, use search_code (cheaper).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Pattern (literal by default; set regex=true)" },
        regex: { type: "boolean", description: "Treat query as a regex" },
        path: { type: "string", description: "Sandbox-relative subdir or single file to scope" },
        glob: { type: "string", description: "Optional file glob (e.g. '*.java')" },
        context_before: { type: "number", description: "Lines BEFORE each match. Default 2, max 30." },
        context_after: { type: "number", description: "Lines AFTER each match. Default 5, max 30." },
        max_matches: { type: "number", description: "Cap matches. Default 20, max 100." },
      },
      required: ["query"],
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const q = String(args.query ?? "");
      if (!q) throw new Error("query is required");
      const before = clamp(args.context_before, 2, 0, 30);
      const after = clamp(args.context_after, 5, 0, 30);
      const max = clamp(args.max_matches, 20, 1, 100);

      const root = sandboxRoot();
      let cwd = root;
      let target = ".";
      if (args.path) {
        const scoped = resolveSandboxedPath(String(args.path));
        const st = await fs.promises.stat(scoped).catch(() => null);
        if (st?.isFile()) {
          cwd = path.dirname(scoped);
          target = path.basename(scoped);
        } else {
          cwd = scoped;
        }
      }

      const argv: string[] = [
        "--no-heading", "--with-filename", "--line-number",
        "--before-context", String(before),
        "--after-context", String(after),
        "--max-count", "5",
        "--max-columns", "200",
        "--max-filesize", "1M",
      ];
      if (!args.regex) argv.push("--fixed-strings");
      if (args.glob) argv.push("-g", String(args.glob));
      argv.push("--", q, target);

      const { stdout } = await execFileP("rg", argv, {
        cwd,
        maxBuffer: 5 * 1024 * 1024,
        timeout: RG_SEARCH_TIMEOUT_MS,
      }).catch((err) => {
        const code = (err as { code?: number | string }).code;
        if (code === 1) return { stdout: "" };
        if (code === "ENOENT") {
          throw new Error(
            "grep_lines requires ripgrep (rg) on PATH. Install: `brew install ripgrep` (macOS), `apt install ripgrep` (Debian/Ubuntu), `choco install ripgrep` (Windows). The mcp-server Docker image ships with it preinstalled."
          );
        }
        throw err;
      });

      // ripgrep emits "file:line:text" for matches and "file-line-text" for
      // context lines, with a "--" separator between match blocks. Group into
      // match-anchored records. Buffer pending pre-match context lines
      // because ripgrep emits BEFORE context first, then match, then AFTER.
      const blocks: Array<{ file: string; line: number; text: string; before: string[]; after: string[] }> = [];
      let current: typeof blocks[number] | null = null;
      let pendingBefore: string[] = [];
      for (const line of stdout.split("\n")) {
        if (!line || line === "--") {
          if (current) {
            blocks.push(current);
            current = null;
          }
          pendingBefore = [];
          continue;
        }
        const matchSep = line.match(/^(.*?):(\d+):(.*)$/);
        const ctxSep = line.match(/^(.*?)-(\d+)-(.*)$/);
        if (matchSep) {
          if (current) blocks.push(current);
          const absPath = path.resolve(cwd, matchSep[1]);
          current = {
            file: path.relative(root, absPath) || matchSep[1],
            line: Number(matchSep[2]),
            text: matchSep[3],
            before: pendingBefore,
            after: [],
          };
          pendingBefore = [];
        } else if (ctxSep) {
          const ctxLine = ctxSep[3];
          if (current && Number(ctxSep[2]) > current.line) {
            current.after.push(ctxLine);
          } else {
            // No current match yet OR this line precedes the next match —
            // buffer as pre-match context.
            pendingBefore.push(ctxLine);
          }
        }
        if (blocks.length >= max) break;
      }
      if (current && blocks.length < max) blocks.push(current);

      return {
        success: true,
        output: {
          query: q,
          regex: Boolean(args.regex),
          scope: args.path ?? ".",
          context_before: before,
          context_after: after,
          count: blocks.length,
          truncated: blocks.length >= max,
          matches: blocks,
        },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

// ── helpers ────────────────────────────────────────────────────────────────

function clamp(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
