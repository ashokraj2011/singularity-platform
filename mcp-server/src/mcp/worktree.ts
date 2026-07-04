// M83 S1 (2026-05-26) — Worktree browser endpoints.
//
// Exposes the workitem's working tree to workgraph-api so the workbench
// can render an in-browser file tree. mcp-server is the natural owner
// because it already mounts the sandbox root at /workspace and knows
// how to resolve per-workitem worktrees via workspaceRootForRunContext.
//
// All paths are validated to live INSIDE the resolved workitem root.
// Symlinks pointing outside the root are refused. Files in the
// SKIP_DIRS set (.git, node_modules, target, etc.) are filtered from
// directory listings by default — they're noise for the operator and
// the agent's own SKIP_DIRS already excludes them from indexing.
//
// Bearer-authenticated via the parent /mcp/ router. workgraph-api
// holds the bearer; the workbench never talks to mcp-server directly.

import { Router } from "express";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { z } from "zod";

import { workspaceRootForRunContext, SKIP_DIRS } from "../workspace/sandbox";
import { AppError } from "../shared/errors";
import { config } from "../config";

export const worktreeRouter: Router = Router();

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB read cap
const MAX_ENTRIES_PER_DIR = 5_000;
const WORKTREE_GIT_HASH_TIMEOUT_MS = config.MCP_WORKTREE_GIT_HASH_TIMEOUT_MS;
const WORKTREE_GIT_WRITE_TIMEOUT_MS = config.MCP_WORKTREE_GIT_WRITE_TIMEOUT_MS;

// Path query schema. We accept relative paths only — the workitem
// root is computed server-side from the URL param.
const pathQuerySchema = z.object({
  path: z.string().max(2000).optional().default(""),
  showHidden: z.enum(["true", "false"]).optional(),
});

const workItemParamSchema = z.object({
  // workItemCode is the WRK-XXXX identifier (M81 P2 branch model). We
  // allow the raw segment so the same endpoint handles both the
  // canonical code and a per-attempt fallback identity. The sandbox
  // resolver does its own slug normalization.
  workItemCode: z.string().min(1).max(120),
});

/**
 * Resolve a candidate relative path inside the workitem root, refusing
 * anything that escapes via `..`, absolute paths, or symlinks pointing
 * outside the root. Returns the resolved absolute path.
 */
function safeResolve(workItemRoot: string, relPath: string): string {
  // Reject absolute paths up front. Even if path.resolve would normalize
  // them, accepting "/etc/passwd" via the API is a footgun.
  if (path.isAbsolute(relPath)) {
    throw new AppError("path must be relative to the workitem root", 400);
  }
  const cleaned = relPath.split("/").filter(Boolean).join("/");
  const candidate = path.resolve(workItemRoot, cleaned);
  // The candidate must be inside the workItemRoot. path.relative resolves
  // to "" when they're identical, "subdir/foo" when nested, "../foo" or
  // absolute when escaping.
  const rel = path.relative(workItemRoot, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AppError("path escapes the workitem root", 400);
  }
  // If the path exists, also realpath-check to catch symlink escapes.
  // Skip when the path doesn't exist yet — the read/write handler will
  // emit a 404 on its own.
  if (fs.existsSync(candidate)) {
    const real = fs.realpathSync(candidate);
    const realRel = path.relative(workItemRoot, real);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      throw new AppError("path target lies outside the workitem root", 400);
    }
  }
  return candidate;
}

/**
 * Resolve the workitem root from the URL param. Returns the absolute
 * directory path on disk. We pass the workItemCode straight through to
 * workspaceRootForRunContext, which handles the M81 P2 per-workitem
 * layout (.singularity/workitems/<code>/).
 *
 * Throws 404 if the directory doesn't exist — i.e. the workitem hasn't
 * been materialized yet.
 */
function resolveWorkItemRoot(workItemCode: string): string {
  const root = workspaceRootForRunContext({ workItemCode });
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new AppError(
      `Workitem ${workItemCode} has no materialized worktree at ${root}. ` +
        `Run the develop stage at least once so the source-cache mirror checks out wi/${workItemCode}.`,
      404,
    );
  }
  return root;
}

/**
 * GET /mcp/worktree/:workItemCode/tree?path=<rel>&showHidden=<bool>
 *
 * Returns a directory listing of <workitem-root>/<rel>. Default-filters
 * SKIP_DIRS (.git, node_modules, target, etc.) unless showHidden=true.
 */
worktreeRouter.get("/:workItemCode/tree", async (req, res, next) => {
  try {
    const params = workItemParamSchema.parse(req.params);
    const query = pathQuerySchema.parse(req.query);
    const root = resolveWorkItemRoot(params.workItemCode);
    const target = safeResolve(root, query.path);
    if (!fs.existsSync(target)) {
      throw new AppError(`Path '${query.path || "."}' not found in workitem ${params.workItemCode}`, 404);
    }
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      throw new AppError(`Path '${query.path}' is a file, not a directory`, 400);
    }
    const showHidden = query.showHidden === "true";
    const raw = fs.readdirSync(target, { withFileTypes: true });
    const entries = raw
      .filter((entry) => {
        if (!showHidden && SKIP_DIRS.has(entry.name)) return false;
        // Hide dotfiles starting with `.` unless explicit (the operator
        // can pass showHidden=true). Common offenders: .DS_Store,
        // .env.local, .vscode etc. — all noise.
        if (!showHidden && entry.name.startsWith(".")) return false;
        return true;
      })
      .slice(0, MAX_ENTRIES_PER_DIR)
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
      }))
      // Directories first, then files, both alphabetical. Matches what
      // operators expect from any file browser.
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({
      success: true,
      data: {
        workItemCode: params.workItemCode,
        workItemRoot: root,
        path: query.path,
        truncated: raw.length > MAX_ENTRIES_PER_DIR,
        entries,
      },
    });
  } catch (err) {
    next(err);
  }
});

// M83 S2 (2026-05-26) — write-file schema. Accepts an operator-authored
// edit + optional commit metadata. The body content is plain text;
// base64 binary writes aren't supported in v1 (text editors only). An
// optional `expectedSha` enables optimistic concurrency — if the file's
// current SHA on disk doesn't match, the write is refused so the
// operator can re-fetch and re-apply.
export const writeFileSchema = z.object({
  content: z.string().max(2_000_000),
  message: z.string().min(1).max(500).optional(),
  expectedSha: z.string().min(7).max(64).optional(),
  // Operator identity for the git author. Set by workgraph-api from
  // the IAM-authenticated request — the client doesn't supply this.
  authorEmail: z.string().email().max(254).optional(),
  authorName: z.string().min(1).max(120).optional(),
});

/**
 * GET /mcp/worktree/:workItemCode/file?path=<rel>
 *
 * Returns the file content as UTF-8 (best-effort — binary files come
 * back base64-encoded with encoding="base64"). 5 MB cap. Refuses
 * directories. Reports file size + last-modified for the workbench.
 */
worktreeRouter.get("/:workItemCode/file", async (req, res, next) => {
  try {
    const params = workItemParamSchema.parse(req.params);
    const query = pathQuerySchema.parse(req.query);
    if (!query.path) {
      throw new AppError("path query parameter is required for file reads", 400);
    }
    const root = resolveWorkItemRoot(params.workItemCode);
    const target = safeResolve(root, query.path);
    if (!fs.existsSync(target)) {
      throw new AppError(`File '${query.path}' not found in workitem ${params.workItemCode}`, 404);
    }
    const stat = fs.statSync(target);
    if (!stat.isFile()) {
      throw new AppError(`Path '${query.path}' is not a regular file`, 400);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new AppError(
        `File '${query.path}' is ${stat.size} bytes; the worktree file endpoint caps at ${MAX_FILE_BYTES}. ` +
          `Open it on disk if you need the full contents.`,
        413,
      );
    }
    const buf = fs.readFileSync(target);
    // Best-effort UTF-8 decode. If the bytes round-trip through
    // toString('utf8') without producing a replacement character at
    // a length we didn't expect, treat as text. Otherwise base64.
    const utf8 = buf.toString("utf8");
    const isBinary = utf8.includes("�");
    // M83 S2 — also return the blob sha so the client can round-trip
    // it as expectedSha on a subsequent PUT. Cheap (in-process git
    // hash-object via shell-out) but avoids the client having to
    // recompute the git blob hash (prefix + size byte + sha-1).
    const blobShaProc = spawnSync("git", ["hash-object", target], {
      encoding: "utf8",
      timeout: WORKTREE_GIT_HASH_TIMEOUT_MS,
    });
    const blobSha = (blobShaProc.stdout ?? "").trim() || null;
    res.json({
      success: true,
      data: {
        workItemCode: params.workItemCode,
        path: query.path,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        encoding: isBinary ? "base64" : "utf-8",
        content: isBinary ? buf.toString("base64") : utf8,
        blobSha,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * M83 S2 — Run a git subcommand in the workitem worktree. Synchronous
 * (spawnSync) because writes are interactive and we want to surface
 * stderr in the error path. The timeout is bounded in config so operators can
 * tune slow network filesystems without introducing an unbounded wait.
 */
function gitInWorktree(workItemRoot: string, args: string[], env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; status: number | null } {
  const proc = spawnSync("git", args, {
    cwd: workItemRoot,
    encoding: "utf8",
    timeout: WORKTREE_GIT_WRITE_TIMEOUT_MS,
    env: { ...process.env, ...env },
  });
  return {
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    status: proc.status,
  };
}

/**
 * PUT /mcp/worktree/:workItemCode/file
 * Body: { path, content, message?, expectedSha?, authorEmail?, authorName? }
 *
 * Writes the file inside the workitem worktree, stages it, and creates
 * a commit on wi/<code> with the supplied author. Returns commit SHA +
 * diff stats so the workbench can confirm the operator's change landed.
 *
 * Refuses if expectedSha is set and doesn't match the file's current
 * blob sha (optimistic concurrency vs. concurrent agent attempts).
 *
 * Push to origin is opt-in via MCP_WORK_BRANCH_PUSH_ON_FINISH — same
 * semantics as the agent's finish_work_branch. Push failure is logged
 * but NOT a stage failure (matches f47efd2 / e4e2d2b).
 */
export type WorktreeWriteInput = z.infer<typeof writeFileSchema> & {
  workItemCode: string;
  path: string;
};

/**
 * Core worktree file-write logic, shared by the HTTP route below and the
 * `worktree-write-file` runtime-bridge frame (laptop/relay-client) so evidence
 * materialization can write into a dial-in runtime's worktree. Writes + stages +
 * commits the file (author = the operator's IAM identity) and returns the
 * { workItemCode, path, edited, ... } payload. Throws AppError on failure.
 */
export function runWorktreeWriteFile(input: WorktreeWriteInput): Record<string, unknown> {
  if (!input.path) {
    throw new AppError("path query parameter is required for file writes", 400);
  }
  const root = resolveWorkItemRoot(input.workItemCode);
  const target = safeResolve(root, input.path);

  // Refuse if target is a directory. New-file creation is allowed —
  // we'll mkdir -p the parent and write fresh.
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    throw new AppError(`Path '${input.path}' is a directory; cannot write file content over it`, 400);
  }

  // Optimistic concurrency: ask git for the file's current blob sha. If the
  // file is untracked, skip the check.
  if (input.expectedSha) {
    const blob = gitInWorktree(root, ["hash-object", target]);
    const currentSha = blob.stdout.trim();
    if (currentSha && !currentSha.startsWith(input.expectedSha) && !input.expectedSha.startsWith(currentSha)) {
      throw new AppError(
        `Stale edit: file's current sha is ${currentSha}, you sent expectedSha=${input.expectedSha}. ` +
          `Re-fetch the file and re-apply your changes — likely an agent attempt landed a commit while you were editing.`,
        409,
      );
    }
  }

  // Make sure parent dir exists, then atomically write (temp file → rename).
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, input.content, { encoding: "utf8" });
  fs.renameSync(tmp, target);

  // Git: add + commit. Author env vars set per-invocation so this is attributed
  // to the operator's IAM identity, not the mcp-server process identity.
  const relTarget = path.relative(root, target);
  const addProc = gitInWorktree(root, ["add", "--", relTarget]);
  if (addProc.status !== 0) {
    throw new AppError(`git add failed: ${addProc.stderr || "unknown error"}`, 500);
  }

  const numstatProc = gitInWorktree(root, ["diff", "--cached", "--numstat", "--", relTarget]);
  const numstatLine = numstatProc.stdout.split("\n").find((l) => l.trim()) ?? "";
  const numstatParts = numstatLine.split("\t");
  const linesAdded = parseInt(numstatParts[0] ?? "0", 10) || 0;
  const linesRemoved = parseInt(numstatParts[1] ?? "0", 10) || 0;
  if (linesAdded === 0 && linesRemoved === 0) {
    // Roll back the empty stage; no commit minted.
    gitInWorktree(root, ["reset", "HEAD", "--", relTarget]);
    const headSha = gitInWorktree(root, ["rev-parse", "HEAD"]).stdout.trim();
    return {
      workItemCode: input.workItemCode,
      path: input.path,
      edited: false,
      reason: "no-op: file content matched HEAD",
      headSha,
    };
  }

  const authorName = input.authorName || "Singularity Operator";
  const authorEmail = input.authorEmail || "operator@singularity.local";
  const message = input.message || `Human edit by ${authorEmail}: ${relTarget}`;
  const commitProc = gitInWorktree(
    root,
    ["commit", "-m", message, "--", relTarget],
    {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    },
  );
  if (commitProc.status !== 0) {
    throw new AppError(`git commit failed: ${commitProc.stderr || commitProc.stdout || "unknown error"}`, 500);
  }
  const commitSha = gitInWorktree(root, ["rev-parse", "HEAD"]).stdout.trim();
  const branch = gitInWorktree(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const newBlobSha = gitInWorktree(root, ["hash-object", target]).stdout.trim();

  return {
    workItemCode: input.workItemCode,
    path: input.path,
    edited: true,
    commitSha,
    branch,
    blobSha: newBlobSha,
    linesAdded,
    linesRemoved,
    author: { name: authorName, email: authorEmail },
    message,
  };
}

worktreeRouter.put("/:workItemCode/file", async (req, res, next) => {
  try {
    const params = workItemParamSchema.parse(req.params);
    const query = pathQuerySchema.parse(req.query);
    const body = writeFileSchema.parse(req.body ?? {});
    const data = runWorktreeWriteFile({ workItemCode: params.workItemCode, path: query.path ?? "", ...body });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});
