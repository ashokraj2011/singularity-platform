import * as path from "node:path";
import * as fs from "node:fs";
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
  // M72 Slice C — Per-attempt isolation. When `attemptId` is supplied, the
  // workspace root is scoped to `.singularity/workitems/<workItem>/<attemptId>/`
  // so two concurrent attempts on the same WorkItem don't stomp on each
  // other's checkouts, file edits, or commits. The source-materializer
  // still creates a git worktree branching from the shared source-cache
  // mirror, so disk + clone cost stays bounded.
  // Backward compat: when attemptId is absent, the layout is unchanged.
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

export function workspaceRootForRunContext(req: WorkspaceRootRequest): string {
  const explicit = safeExplicitWorkspaceRoot(req.workspaceRoot);
  if (explicit) return explicit;
  const identity = req.workItemCode?.trim()
    || (req.branchName?.trim() ? safeWorkspaceSegment(req.branchName, "") : "")
    || req.workItemId?.trim();
  if (!identity) return baseSandboxRoot();
  const base = path.join(workItemWorkspacesRoot(), safeWorkspaceSegment(identity, "workitem"));
  // M72 Slice C — Append the attempt segment when caller supplied an
  // attemptId so concurrent attempts on the same WorkItem land in
  // separate directories. safeWorkspaceSegment strips path separators
  // and unsafe chars; `attempts/` is hardcoded so the parent directory
  // is grep-able for the janitor (M72C-followup) to enumerate.
  const attempt = req.attemptId?.trim();
  if (attempt) {
    return path.join(base, "attempts", safeWorkspaceSegment(attempt, "attempt"));
  }
  return base;
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
