import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { CorrelationIds } from "../audit/store";
import { config } from "../config";
import { events } from "../events/bus";
import { baseSandboxRoot, sandboxRoot, SKIP_DIRS } from "./sandbox";

const execFileP = promisify(execFile);

export interface WorkspaceSourceRequest {
  sourceType?: string;
  sourceUri?: string;
  sourceRef?: string;
}

export interface WorkspaceSourceStatus {
  checkedOut: boolean;
  sourceType?: string;
  sourceUri?: string;
  sourceRef?: string;
  remoteUrl?: string;
  headSha?: string;
  workspaceRoot?: string;
  message: string;
}

async function git(args: string[], opts?: { cwd?: string; allowFail?: boolean; maxBuffer?: number }): Promise<string> {
  const cwd = opts?.cwd ?? sandboxRoot();
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      env: {
        ...process.env,
        // Work-item workspaces live underneath the main sandbox. Without a
        // ceiling, git commands in an uninitialized work-item folder can walk
        // upward and accidentally operate on the parent sandbox repository.
        GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(cwd)),
      },
      maxBuffer: opts?.maxBuffer ?? 20 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    if (opts?.allowFail) return "";
    throw err;
  }
}

function githubCloneUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const [owner, repo] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!owner || !repo) return null;
    return `https://github.com/${owner}/${repo.replace(/\.git$/i, "")}.git`;
  } catch {
    return null;
  }
}

function localSourcePath(raw: string): string | null {
  try {
    if (raw.startsWith("file://")) return new URL(raw).pathname;
  } catch {
    return null;
  }
  if (raw.startsWith("/") || raw.startsWith("~")) {
    return raw.replace(/^~/, process.env.HOME ?? "~");
  }
  return null;
}

function normalizeRemote(raw?: string): string {
  if (!raw) return "";
  return raw
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

async function removeWorkspaceContents(root: string): Promise<void> {
  await fs.promises.mkdir(root, { recursive: true });
  const entries = await fs.promises.readdir(root).catch(() => []);
  for (const entry of entries) {
    if (entry === ".singularity") continue;
    await fs.promises.rm(path.join(root, entry), { recursive: true, force: true });
  }
}

async function dirtyPaths(): Promise<string[]> {
  const porcelain = await git(["status", "--porcelain"], { allowFail: true });
  return porcelain.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function currentRemote(): Promise<string> {
  return await git(["remote", "get-url", "origin"], { allowFail: true });
}

async function currentHead(): Promise<string | undefined> {
  return await git(["rev-parse", "HEAD"], { allowFail: true }) || undefined;
}

async function checkoutRef(sourceRef?: string): Promise<void> {
  const ref = sourceRef?.trim();
  if (!ref) return;
  await git(["fetch", "--depth=1", "origin", ref], { allowFail: true });
  const remoteRef = await git(["rev-parse", "--verify", `origin/${ref}`], { allowFail: true });
  if (remoteRef) {
    await git(["checkout", "-B", ref.replace(/[^a-zA-Z0-9._/-]+/g, "-"), `origin/${ref}`]);
    return;
  }
  const fetched = await git(["rev-parse", "--verify", "FETCH_HEAD"], { allowFail: true });
  if (fetched) await git(["checkout", "--detach", "FETCH_HEAD"]);
}

async function cloneIntoWorkspace(cloneUrl: string, sourceRef?: string): Promise<void> {
  const root = sandboxRoot();
  await removeWorkspaceContents(root);
  await git(["init", "-q"], { cwd: root });
  await git(["remote", "remove", "origin"], { cwd: root, allowFail: true });
  await git(["remote", "add", "origin", cloneUrl], { cwd: root });
  const ref = sourceRef?.trim();
  if (ref) {
    try {
      await git(["fetch", "--depth=1", "origin", ref], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
      await checkoutRef(ref);
    } catch {
      await removeWorkspaceContents(root);
      await git(["init", "-q"], { cwd: root });
      await git(["remote", "add", "origin", cloneUrl], { cwd: root });
      await git(["fetch", "--depth=1", "origin"], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
      await git(["checkout", "-B", "main", "FETCH_HEAD"], { cwd: root });
    }
  } else {
    await git(["fetch", "--depth=1", "origin"], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
    await git(["checkout", "-B", "main", "FETCH_HEAD"], { cwd: root });
  }
}

async function gitBare(
  gitDir: string,
  args: string[],
  opts?: { allowFail?: boolean; maxBuffer?: number },
): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["--git-dir", gitDir, ...args], {
      cwd: path.dirname(gitDir),
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: opts?.maxBuffer ?? 20 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    if (opts?.allowFail) return "";
    throw err;
  }
}

async function gitRaw(
  args: string[],
  opts?: { cwd?: string; allowFail?: boolean; maxBuffer?: number },
): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd: opts?.cwd ?? baseSandboxRoot(),
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: opts?.maxBuffer ?? 20 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    if (opts?.allowFail) return "";
    throw err;
  }
}

function sourceCacheRoot(): string {
  const configured = config.MCP_SOURCE_CACHE_ROOT?.trim();
  if (!configured) return path.join(baseSandboxRoot(), ".singularity", "source-cache");
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(baseSandboxRoot(), configured);
}

function sourceCachePath(rawRemote: string): string {
  const key = createHash("sha256")
    .update(normalizeRemote(rawRemote) || rawRemote)
    .digest("hex")
    .slice(0, 24);
  return path.join(sourceCacheRoot(), `${key}.git`);
}

async function ensureMirror(cloneUrl: string): Promise<string> {
  const cacheRoot = sourceCacheRoot();
  const mirror = sourceCachePath(cloneUrl);
  await fs.promises.mkdir(cacheRoot, { recursive: true });
  const hasHead = Boolean(await fs.promises.stat(path.join(mirror, "HEAD")).catch(() => null));
  if (!hasHead) {
    await fs.promises.rm(mirror, { recursive: true, force: true });
    await gitRaw(["clone", "--mirror", cloneUrl, mirror], { cwd: cacheRoot, maxBuffer: 60 * 1024 * 1024 });
    // M70.6 — `git clone --mirror` sets `remote.origin.mirror = true`,
    // which is fine for fetching but BREAKS every subsequent
    // `git push origin <refspec>` from any worktree of this repo:
    //   fatal: --mirror can't be combined with refspecs
    // The agent's finish_work_branch always pushes a specific branch
    // refspec, so the workitem-level push fails until the bare repo's
    // config is fixed. Unset the mirror flag here. The explicit
    // `fetch = +refs/*:refs/*` we already configure still pulls every
    // ref on subsequent fetches, so we keep the mirror-style fetch
    // behavior without the push-time poison.
    await gitBare(mirror, ["config", "--unset", "remote.origin.mirror"], { allowFail: true });
    return mirror;
  }
  // Idempotent self-heal: even if this mirror was created by a prior
  // (pre-M70.6) build that didn't unset the mirror flag, fix it now
  // so the next push succeeds. allowFail covers the case where the
  // flag is already unset.
  await gitBare(mirror, ["config", "--unset", "remote.origin.mirror"], { allowFail: true });
  await gitBare(mirror, ["remote", "set-url", "origin", cloneUrl], { allowFail: true });
  await gitBare(mirror, ["fetch", "--prune", "origin"], { allowFail: true, maxBuffer: 60 * 1024 * 1024 });
  return mirror;
}

async function resolveMirrorCommit(mirror: string, sourceRef?: string): Promise<string> {
  const ref = sourceRef?.trim();
  if (ref) {
    await gitBare(mirror, ["fetch", "--prune", "origin", ref], { allowFail: true, maxBuffer: 60 * 1024 * 1024 });
    const candidates = [
      `refs/remotes/origin/${ref}`,
      `refs/heads/${ref}`,
      "FETCH_HEAD",
      ref,
    ];
    for (const candidate of candidates) {
      const commit = await gitBare(mirror, ["rev-parse", "--verify", `${candidate}^{commit}`], { allowFail: true });
      if (commit) return commit;
    }
  }
  const originHead = await gitBare(mirror, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { allowFail: true });
  if (originHead) {
    const commit = await gitBare(mirror, ["rev-parse", "--verify", `${originHead}^{commit}`], { allowFail: true });
    if (commit) return commit;
  }
  const head = await gitBare(mirror, ["rev-parse", "--verify", "HEAD^{commit}"], { allowFail: true });
  if (head) return head;
  throw new Error("Unable to resolve a commit from the shared source cache.");
}

async function materializeGitWorktreeFromCache(cloneUrl: string, sourceRef?: string): Promise<void> {
  const root = sandboxRoot();
  if (path.resolve(root) === baseSandboxRoot()) {
    throw new Error("Shared git cache worktrees require a per-run workspace root.");
  }
  const mirror = await ensureMirror(cloneUrl);
  const commit = await resolveMirrorCommit(mirror, sourceRef);
  await gitBare(mirror, ["worktree", "prune"], { allowFail: true });
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(root), { recursive: true });
  await gitBare(mirror, ["worktree", "add", "--detach", "--force", root, commit], { maxBuffer: 60 * 1024 * 1024 });
}

async function materializeGitSource(cloneUrl: string, sourceRef?: string): Promise<string> {
  const expected = normalizeRemote(cloneUrl);
  const workspaceHasGit = fs.existsSync(path.join(sandboxRoot(), ".git"));
  const existingRemote = workspaceHasGit ? normalizeRemote(await currentRemote()) : "";
  const dirty = workspaceHasGit ? await dirtyPaths() : [];
  if (existingRemote && existingRemote !== expected && dirty.length > 0) {
    throw new Error(`MCP workspace has dirty changes for a different repo (${existingRemote}); refusing to replace it with ${expected}`);
  }
  if (existingRemote === expected && dirty.length > 0) {
    return "workspace source retained with local changes";
  }
  try {
    await materializeGitWorktreeFromCache(cloneUrl, sourceRef);
    return "workspace source materialized from shared git cache";
  } catch {
    await cloneIntoWorkspace(cloneUrl, sourceRef);
    return existingRemote === expected ? "workspace source refreshed" : "workspace source cloned";
  }
}

async function copyLocalDirectoryIntoWorkspace(sourcePath: string): Promise<void> {
  const root = sandboxRoot();
  const resolvedSource = path.resolve(sourcePath);
  if (resolvedSource === path.resolve(root)) return;
  await removeWorkspaceContents(root);
  await fs.promises.cp(resolvedSource, root, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(resolvedSource, src);
      if (!rel) return true;
      return !rel.split(path.sep).some((part) => SKIP_DIRS.has(part));
    },
  });
  await git(["init", "-q"], { cwd: root, allowFail: true });
}

async function configureGitIdentity(): Promise<void> {
  await git(["config", "user.email", "mcp@local"], { allowFail: true });
  await git(["config", "user.name", "MCP Server"], { allowFail: true });
}

export async function ensureWorkspaceSource(
  req: WorkspaceSourceRequest,
  correlation?: CorrelationIds,
): Promise<WorkspaceSourceStatus | null> {
  if (!config.MCP_AUTO_CHECKOUT_SOURCE) return null;
  const sourceType = req.sourceType?.trim().toLowerCase();
  const sourceUri = req.sourceUri?.trim();
  if (!sourceUri) return null;

  if (sourceType && ["local", "local_dir", "local-directory", "filesystem", "dir"].includes(sourceType)) {
    const localPath = localSourcePath(sourceUri);
    if (!localPath) {
      return {
        checkedOut: false,
        sourceType,
        sourceUri,
        sourceRef: req.sourceRef,
        workspaceRoot: sandboxRoot(),
        message: "Local source URI must be an absolute path or file:// URL.",
      };
    }
    const stat = await fs.promises.stat(localPath).catch(() => null);
    if (!stat?.isDirectory()) {
      return {
        checkedOut: false,
        sourceType,
        sourceUri,
        sourceRef: req.sourceRef,
        workspaceRoot: sandboxRoot(),
        message: `Local source path was not found or is not a directory: ${localPath}`,
      };
    }
    let message = "local workspace source materialized";
    if (fs.existsSync(path.join(localPath, ".git"))) {
      message = await materializeGitSource(localPath, req.sourceRef);
    } else {
      await copyLocalDirectoryIntoWorkspace(localPath);
    }
    await configureGitIdentity();
    const status: WorkspaceSourceStatus = {
      checkedOut: true,
      sourceType,
      sourceUri,
      sourceRef: req.sourceRef,
      remoteUrl: await currentRemote(),
      headSha: await currentHead(),
      workspaceRoot: sandboxRoot(),
      message,
    };
    events.publish({
      kind: "workspace.source.checked_out",
      correlation: correlation ?? { mcpInvocationId: "workspace" },
      payload: { ...status },
    });
    return status;
  }

  if (sourceType !== "github") return null;

  const cloneUrl = githubCloneUrl(sourceUri);
  if (!cloneUrl) {
    return {
      checkedOut: false,
      sourceType,
      sourceUri,
      sourceRef: req.sourceRef,
      workspaceRoot: sandboxRoot(),
      message: "Only github.com source URLs can be automatically materialized by MCP v1.",
    };
  }

  const message = await materializeGitSource(cloneUrl, req.sourceRef);
  await configureGitIdentity();

  const status: WorkspaceSourceStatus = {
    checkedOut: true,
    sourceType,
    sourceUri,
    sourceRef: req.sourceRef,
    remoteUrl: await currentRemote(),
    headSha: await currentHead(),
    workspaceRoot: sandboxRoot(),
    message,
  };
  events.publish({
    kind: "workspace.source.checked_out",
    correlation: correlation ?? { mcpInvocationId: "workspace" },
    payload: { ...status },
  });
  return status;
}
