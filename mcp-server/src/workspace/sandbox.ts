import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config";

// M27.5 — Go + Java added so the AST index covers the four languages our
// agents actually edit (TS/JS, Python, Go, Java). Kotlin / Rust / C# WASMs
// also ship with tree-sitter-wasms; wire them later when needed.
export const SOURCE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|java)$/i;

export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".singularity", "dist", "build", "out", "__pycache__", ".venv", "venv",
  ".next", ".turbo", ".cache", "coverage", "target",
  // M27.5 — Go + Java build/cache directories. `vendor/` is debated for Go
  // (some teams check it in) but containing thousands of dep files in the
  // AST index isn't useful for the agent loop.
  "vendor", ".gradle", ".idea", "bin",
]);

const sandboxContext = new AsyncLocalStorage<string>();

export interface WorkspaceRootRequest {
  workItemId?: string;
  workItemCode?: string;
  branchName?: string;
  workspaceRoot?: string;
  // (2026-06-02 M81 cross-stage fix) The long-lived workitem branch
  // `wi/<workItemCode>` that workgraph-api stamps onto EVERY stage of a run.
  // Used here as a second source for the workitem code so that review / QA /
  // security stages resolve to the SAME per-workitem worktree the developer
  // stage committed to — even when the explicit `workItemCode` field never
  // reached the resolver (the canonical failure: context-fabric ships the
  // governed run_context in snake_case and the camelCase `workItemCode` slot
  // arrives empty, so resolution silently fell through to the base sandbox
  // root and the review agent re-cloned `/workspace` instead of reading the
  // dev's diff). See workspaceRootForRunContext for the resolution order.
  workitemBranch?: string;
  // (2026-06-02 M81 cross-stage fix) Stage-stable workflow identity. Constant
  // across every stage of a single run, so it serves as a last-resort key
  // BEFORE the base sandbox root: a run with no linked WorkItem still keeps
  // all its stages in one shared sandbox instead of having some stages
  // diverge onto `/workspace`.
  workflowInstanceId?: string;
  // M72 Slice C — Per-attempt isolation. When `attemptId` is supplied, the
  // workspace root is scoped to `.singularity/workitems/<workItem>/<attemptId>/`
  // so two concurrent attempts on the same WorkItem don't stomp on each
  // other's checkouts, file edits, or commits. The source-materializer
  // still creates a git worktree branching from the shared source-cache
  // mirror, so disk + clone cost stays bounded.
  // Superseded by M81 P2 (one-worktree-per-workitem); kept on the interface
  // for backward compat but intentionally ignored by the resolver below.
  attemptId?: string;
}

function safeWorkspaceSegment(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? fallback)
    .trim()
    .replace(/^work\//i, "")
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

export function baseSandboxRoot(): string {
  return path.resolve(config.MCP_SANDBOX_ROOT);
}

export function workItemWorkspacesRoot(): string {
  const configured = config.MCP_WORKITEM_WORKSPACES_ROOT?.trim();
  if (!configured) return path.join(baseSandboxRoot(), ".singularity", "workitems");
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(baseSandboxRoot(), configured);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeExplicitWorkspaceRoot(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const resolved = path.resolve(trimmed);
  const base = baseSandboxRoot();
  const workspaces = workItemWorkspacesRoot();
  if (isInside(base, resolved) || isInside(workspaces, resolved)) return resolved;
  return undefined;
}

// M83 task #176 (2026-05-26) — Cache the workspace-root lookup per
// (identity, expected-branch) so we don't shell out to `git` on every
// tool dispatch. Invalidated only by process restart. Keys include
// the expected wi/<code> branch so a stale entry can't survive a
// rename.
const worktreeRootCache = new Map<string, string>();

/**
 * For a given workitem identity, find the worktree dir whose git HEAD
 * is on `wi/<workItemCode>`. The fast path is the canonical
 * `<base>/<workItemCode>` directory — for fresh workitems created by
 * M81 source-materializer, that's always correct. The slow path runs
 * only when the canonical dir exists but is on the wrong branch
 * (legacy debris from per-attempt naming pre-M81 P2), in which case
 * we scan sibling directories for one whose HEAD matches.
 *
 * Returns the absolute path. Cached per process.
 */
function resolveWiBranchWorktree(workItemCode: string, fallback: string): string {
  const expectedBranch = `wi/${workItemCode}`;
  const cacheKey = `${workItemCode}|${expectedBranch}`;
  const cached = worktreeRootCache.get(cacheKey);
  if (cached && fs.existsSync(cached)) return cached;

  // Fast path: canonical dir exists and is on the right branch.
  if (fs.existsSync(fallback) && isOnBranch(fallback, expectedBranch)) {
    worktreeRootCache.set(cacheKey, fallback);
    return fallback;
  }

  // Slow path: scan sibling dirs (typical case = a 36-char UUID
  // from older runs that holds the correct wi/<code> checkout while
  // the canonical short-code dir is on a stale per-attempt branch).
  const workspacesRoot = workItemWorkspacesRoot();
  if (fs.existsSync(workspacesRoot)) {
    try {
      const siblings = fs.readdirSync(workspacesRoot, { withFileTypes: true });
      for (const entry of siblings) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(workspacesRoot, entry.name);
        if (candidate === fallback) continue;
        if (isOnBranch(candidate, expectedBranch)) {
          worktreeRootCache.set(cacheKey, candidate);
          return candidate;
        }
      }
    } catch {
      // readdir failed; nothing we can do, fall through to canonical
    }
  }

  // Nothing found. Return canonical; M81 source-materializer will
  // create it on first checkout and put it on the right branch.
  worktreeRootCache.set(cacheKey, fallback);
  return fallback;
}

function isOnBranch(dir: string, expectedBranch: string): boolean {
  if (!fs.existsSync(path.join(dir, ".git"))) return false;
  try {
    const proc = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 2_000,
    });
    if (proc.status !== 0) return false;
    return (proc.stdout ?? "").trim() === expectedBranch;
  } catch {
    return false;
  }
}

/**
 * Extract the workitem code from a long-lived workitem branch
 * (`wi/<workItemCode>`). Returns "" when `branch` is empty or doesn't carry a
 * usable segment. The `wi/` prefix is stripped explicitly so a branch like
 * `wi/WRK-984AD` yields `WRK-984AD`; safeWorkspaceSegment then sanitises it the
 * same way an explicit workItemCode would be sanitised, so both sources land on
 * the identical canonical worktree directory.
 */
function workItemCodeFromBranch(branch: string | undefined): string {
  const trimmed = branch?.trim();
  if (!trimmed) return "";
  const withoutPrefix = trimmed.replace(/^wi\//i, "");
  return safeWorkspaceSegment(withoutPrefix, "");
}

export function workspaceRootForRunContext(req: WorkspaceRootRequest): string {
  const explicit = safeExplicitWorkspaceRoot(req.workspaceRoot);
  if (explicit) return explicit;

  // (2026-06-02 M81 cross-stage fix) Resolve the workitem code from EITHER the
  // explicit `workItemCode` OR the `wi/<code>` workitem branch. workgraph-api
  // stamps both onto every stage of a run, but the camelCase `workItemCode`
  // slot can arrive empty when context-fabric ships the governed run_context in
  // snake_case (the `workitem_branch` alias is honoured wire-side; the
  // un-aliased `work_item_code` is dropped). Deriving the code from the branch
  // as well guarantees that develop, qa-review, and security-review all key off
  // the same `wi/<code>` worktree instead of some stages slipping through to a
  // divergent root.
  const workItemCode = req.workItemCode?.trim() || workItemCodeFromBranch(req.workitemBranch);
  if (workItemCode) {
    const base = path.join(workItemWorkspacesRoot(), safeWorkspaceSegment(workItemCode, "workitem"));
    // M83 task #176 — prefer whichever sibling dir is already checked out on
    // `wi/<code>` over the canonical path. No-op for fresh workitems (canonical
    // IS the right one); only matters for legacy debris where the canonical dir
    // holds a stale pre-M81 per-attempt branch.
    return resolveWiBranchWorktree(workItemCode, base);
  }

  // No workitem code. Fall back to the remaining identities in
  // MOST-STABLE-FIRST order. The crucial change vs. the original ordering is
  // that `branchName` is now LAST, below `workItemId` and `workflowInstanceId`:
  // workgraph-api's per-attempt workbench branch (`sg/<base>/<stage>/<attempt>`)
  // VARIES per stage, so keying off it split a single run's stages across
  // sibling worktrees — the developer landed in one dir, security-review in
  // another (or, with nothing else to key on, in the base sandbox root). The
  // workItemId and workflowInstanceId are constant across a run's stages, so
  // they keep every stage in one shared sandbox.
  //
  // M81 P2 (2026-05-26) — `attemptId` is intentionally ignored. Per-attempt
  // isolation was replaced by the no-parallel-attempts guard + the long-lived
  // `wi/<code>` branch model, and re-introducing it here would re-open the
  // worktree-split failure mode. It stays on the interface for backward compat.
  void req.attemptId;
  const identity = req.workItemId?.trim()
    || req.workflowInstanceId?.trim()
    || (req.branchName?.trim() ? safeWorkspaceSegment(req.branchName, "") : "");
  if (!identity) return baseSandboxRoot();
  return path.join(workItemWorkspacesRoot(), safeWorkspaceSegment(identity, "workitem"));
}

export async function withSandboxRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(root);
  await fs.promises.mkdir(resolved, { recursive: true });
  return await new Promise<T>((resolve, reject) => {
    sandboxContext.run(resolved, () => {
      Promise.resolve()
        .then(fn)
        .then(resolve, reject);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeStaleLock(lockPath: string): Promise<void> {
  const stat = await fs.promises.stat(lockPath).catch(() => null);
  if (!stat) return;
  if (Date.now() - stat.mtimeMs > config.MCP_WORKSPACE_LOCK_STALE_MS) {
    await fs.promises.rm(lockPath, { force: true });
  }
}

export async function withWorkspaceLock<T>(fn: () => Promise<T>): Promise<T> {
  const root = sandboxRoot();
  const dir = path.join(root, ".singularity");
  const lockPath = path.join(dir, "workspace.lock");
  await fs.promises.mkdir(dir, { recursive: true });
  const started = Date.now();
  let handle: fs.promises.FileHandle | undefined;
  while (!handle) {
    try {
      await removeStaleLock(lockPath);
      handle = await fs.promises.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        root,
      }), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - started > config.MCP_WORKSPACE_LOCK_TIMEOUT_MS) {
        // Surface lock-holder metadata so the operator can decide whether to
        // wait or kill the stale run. Previously the message was just "locked"
        // which was confusable with workspace-is-broken — operators thought
        // they needed to wipe state when the actual cause was a concurrent
        // run still finishing.
        let holder = "(unknown)";
        try {
          const buf = await fs.promises.readFile(lockPath, "utf8");
          const parsed = JSON.parse(buf) as { pid?: number; createdAt?: string };
          if (parsed.createdAt) {
            const ageSec = Math.round((Date.now() - new Date(parsed.createdAt).getTime()) / 1000);
            holder = `pid=${parsed.pid ?? "?"} age=${ageSec}s`;
          }
        } catch { /* lock file gone or unparseable — leave holder=unknown */ }
        throw new Error(
          `workspace is locked by an in-progress run (${holder}) at ${root}. ` +
            `Wait for it to finish, or if you believe the previous run died, delete ${lockPath} manually. ` +
            `Stale locks older than MCP_WORKSPACE_LOCK_STALE_MS are auto-cleared on the next attempt.`,
        );
      }
      await sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function directorySizeBytes(root: string): Promise<number> {
  let total = 0;
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directorySizeBytes(abs);
    else if (entry.isFile()) total += (await fs.promises.stat(abs).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export async function gcWorkItemWorkspaces(): Promise<{
  scanned: number;
  removed: number;
  bytesRemoved: number;
}> {
  if (!config.MCP_WORKSPACE_GC_ENABLED) return { scanned: 0, removed: 0, bytesRemoved: 0 };
  const root = workItemWorkspacesRoot();
  const maxAgeMs = config.MCP_WORKSPACE_GC_MAX_AGE_HOURS * 60 * 60 * 1000;
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  let scanned = 0;
  let removed = 0;
  let bytesRemoved = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    scanned += 1;
    const abs = path.join(root, entry.name);
    const lockPath = path.join(abs, ".singularity", "workspace.lock");
    const lockStat = await fs.promises.stat(lockPath).catch(() => null);
    if (lockStat && Date.now() - lockStat.mtimeMs <= config.MCP_WORKSPACE_LOCK_STALE_MS) continue;
    const stat = await fs.promises.stat(abs).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs <= maxAgeMs) continue;
    const size = await directorySizeBytes(abs);
    await fs.promises.rm(abs, { recursive: true, force: true });
    removed += 1;
    bytesRemoved += size;
  }
  return { scanned, removed, bytesRemoved };
}

function configuredSourceCacheRoot(): string {
  const configured = config.MCP_SOURCE_CACHE_ROOT?.trim();
  if (!configured) return path.join(baseSandboxRoot(), ".singularity", "source-cache");
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(baseSandboxRoot(), configured);
}

export async function workspaceStorageStats(): Promise<{
  baseSandboxRoot: string;
  workItemWorkspacesRoot: string;
  sourceCacheRoot: string;
  workItemWorkspaceCount: number;
  workItemBytes: number;
  sourceCacheBytes: number;
  totalManagedBytes: number;
  quotaBytes: number | null;
  quotaUsedPercent: number | null;
  gc: {
    enabled: boolean;
    maxAgeHours: number;
    lockTimeoutMs: number;
    lockStaleMs: number;
  };
}> {
  const workRoot = workItemWorkspacesRoot();
  const cacheRoot = configuredSourceCacheRoot();
  const workEntries = await fs.promises.readdir(workRoot, { withFileTypes: true }).catch(() => []);
  const workItemWorkspaceCount = workEntries.filter((entry) => entry.isDirectory()).length;
  const workItemBytes = await directorySizeBytes(workRoot).catch(() => 0);
  const sourceCacheBytes = await directorySizeBytes(cacheRoot).catch(() => 0);
  const totalManagedBytes = workItemBytes + sourceCacheBytes;
  const quotaBytes = config.MCP_WORKSPACE_DISK_QUOTA_BYTES > 0 ? config.MCP_WORKSPACE_DISK_QUOTA_BYTES : null;
  return {
    baseSandboxRoot: baseSandboxRoot(),
    workItemWorkspacesRoot: workRoot,
    sourceCacheRoot: cacheRoot,
    workItemWorkspaceCount,
    workItemBytes,
    sourceCacheBytes,
    totalManagedBytes,
    quotaBytes,
    quotaUsedPercent: quotaBytes ? (totalManagedBytes / quotaBytes) * 100 : null,
    gc: {
      enabled: config.MCP_WORKSPACE_GC_ENABLED,
      maxAgeHours: config.MCP_WORKSPACE_GC_MAX_AGE_HOURS,
      lockTimeoutMs: config.MCP_WORKSPACE_LOCK_TIMEOUT_MS,
      lockStaleMs: config.MCP_WORKSPACE_LOCK_STALE_MS,
    },
  };
}

export function sandboxRoot(): string {
  return sandboxContext.getStore() ?? baseSandboxRoot();
}

export function resolveSandboxedPath(relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("path is required");
  }
  if (relPath.startsWith("/") || relPath.startsWith("\\")) {
    throw new Error("absolute paths are not allowed");
  }
  const root = sandboxRoot();
  const joined = path.resolve(root, relPath);
  if (joined !== root && !joined.startsWith(root + path.sep)) {
    throw new Error("path escapes the sandbox root");
  }
  return joined;
}

export function toRelativeSandboxPath(absPath: string): string {
  const rel = path.relative(sandboxRoot(), path.resolve(absPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escapes the sandbox root");
  }
  return rel || ".";
}
