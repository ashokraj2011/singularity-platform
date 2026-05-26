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
import { z } from "zod";

import { workspaceRootForRunContext, SKIP_DIRS } from "../workspace/sandbox";
import { AppError } from "../shared/errors";

export const worktreeRouter: Router = Router();

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB read cap
const MAX_ENTRIES_PER_DIR = 5_000;

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
    res.json({
      success: true,
      data: {
        workItemCode: params.workItemCode,
        path: query.path,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        encoding: isBinary ? "base64" : "utf-8",
        content: isBinary ? buf.toString("base64") : utf8,
      },
    });
  } catch (err) {
    next(err);
  }
});
