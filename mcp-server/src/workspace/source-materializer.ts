import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { CorrelationIds } from "../audit/store";
import { config } from "../config";
import { events } from "../events/bus";
import { gitAskpassEnv } from "./git-workspace";
import { baseSandboxRoot, sandboxRoot, SKIP_DIRS } from "./sandbox";

const execFileP = promisify(execFile);
const SOURCE_MATERIALIZER_GIT_TIMEOUT_MS = config.MCP_SOURCE_MATERIALIZER_GIT_TIMEOUT_MS;

export interface WorkspaceSourceRequest {
  sourceType?: string;
  sourceUri?: string;
  sourceRef?: string;
  // (2026-05-26 M81) Workitem-scoped long-lived branch. When supplied, the
  // materializer:
  //   1. Resolves the source-cache mirror and `git fetch`es origin
  //   2. Checks `refs/remotes/origin/<workitemBranch>` — if present, the
  //      worktree HEAD lands on that branch (continuity across machines/sessions)
  //   3. Otherwise, creates `<workitemBranch>` locally from sourceRef (typically
  //      main) so subsequent commits land on it
  // Every stage of the workflow that runs against the same workitemBranch
  // shares the branch's history, so dev edits remain visible to security/QA
  // without needing per-attempt worktree handoffs. Pair with the per-workitem
  // sandbox layout (workspaceRootForRunContext returns the workitem root
  // when attemptId is omitted) and the no-parallel-attempts guard in
  // workgraph-api to eliminate the worktree-split failure mode.
  workitemBranch?: string;
  // P0 #2 — brokered, short-lived, repo-scoped READ credential for the private-repo
  // clone/fetch. Held in-memory only for the materialization network calls below,
  // then discarded. Absent ⇒ fall back to the static GITHUB_TOKEN (current
  // behavior). Never persisted or logged.
  gitToken?: string;
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
  // (2026-05-26 M81) When workitemBranch was requested, this carries the
  // active branch name + whether it was checked out from remote (vs created
  // locally from sourceRef). Lets audit/UI distinguish "resuming a workitem"
  // from "starting a fresh one".
  workitemBranch?: string;
  workitemBranchOrigin?: "remote" | "local-cache" | "created-from-source-ref";
}

async function git(args: string[], opts?: { cwd?: string; allowFail?: boolean; maxBuffer?: number; authEnv?: NodeJS.ProcessEnv }): Promise<string> {
  const cwd = opts?.cwd ?? sandboxRoot();
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      env: {
        ...process.env,
        // P0 #2 — brokered clone credential (askpass env). Spread before the
        // ceiling so it wins over inherited GIT_* but never clobbers the safety
        // ceiling below.
        ...(opts?.authEnv ?? {}),
        // Work-item workspaces live underneath the main sandbox. Without a
        // ceiling, git commands in an uninitialized work-item folder can walk
        // upward and accidentally operate on the parent sandbox repository.
        GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(cwd)),
      },
      timeout: SOURCE_MATERIALIZER_GIT_TIMEOUT_MS,
      maxBuffer: opts?.maxBuffer ?? 20 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    if (opts?.allowFail) return "";
    throw err;
  }
}

// [P1] Repo-grounding resilience — a `git fetch` is a network round trip and
// the single most failure-prone step in materialization. Retry transient
// failures with backoff before giving up. Returns whether the fetch ultimately
// succeeded (stdout is empty on success, so the boolean — not the output — is
// how callers know). Never throws; callers decide what an exhausted fetch means
// (fall back to a cached base WITH a warning, or fail the stage).
async function gitFetchWithRetry(
  args: string[],
  opts?: { cwd?: string; maxBuffer?: number; attempts?: number; authEnv?: NodeJS.ProcessEnv },
): Promise<boolean> {
  const attempts = Math.max(1, opts?.attempts ?? 3);
  for (let i = 0; i < attempts; i += 1) {
    try {
      await git(args, { cwd: opts?.cwd, maxBuffer: opts?.maxBuffer ?? 20 * 1024 * 1024, authEnv: opts?.authEnv });
      return true;
    } catch (err) {
      if (i === attempts - 1) {
        console.warn(
          `[source-materializer] git ${args.join(" ")} failed after ${attempts} attempt(s): ${(err as Error).message}`,
        );
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** i));
    }
  }
  return false;
}

// M-fix (cwd race) — initialize a git repo at an EXPLICIT target directory,
// run from the stable parent dir, never from `root` itself.
//
// PR #58 added `--template=` to skip git's hook-copy step (fixes the
// `.git/hooks/*.sample` "File exists" crash on the macOS bind-mount). This
// is a DIFFERENT failure of the same command: when two flows materialize into
// the same shared sandbox root, one's removeWorkspaceContents() can clear the
// directory out from under git mid-`init`, so git's getcwd() aborts with
//   fatal: unable to get current working directory: No such file or directory
// Passing the dir as a positional arg and running from its parent makes `init`
// independent of the volatile cwd. (The per-root mutex around
// ensureWorkspaceSource closes the underlying race; this is belt-and-braces
// and also covers stale-inode hiccups on the bind-mount.)
async function initRepoAtRoot(root: string, opts?: { allowFail?: boolean }): Promise<void> {
  await fs.promises.mkdir(root, { recursive: true });
  const parent = path.dirname(path.resolve(root));
  await git(["init", "-q", "--template=", root], { cwd: parent, allowFail: opts?.allowFail });
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

// #23 — gate `local`/filesystem sources to an allowlist of root prefixes. A local
// source can be any absolute path on this mcp-server host; on a shared cloud
// mcp-server that's a local-FS-read risk. Operators set MCP_ALLOWED_LOCAL_SOURCE_ROOTS
// to lock it down. UNSET ⇒ allow any (preserves the laptop/dev flow). The check
// uses the RESOLVED path so `..` traversal can't escape an allowed root.
// Exported for the allowlist unit test.
export function localSourceRootAllowed(resolvedPath: string): boolean {
  const raw = config.MCP_ALLOWED_LOCAL_SOURCE_ROOTS?.trim();
  if (!raw) return true;
  const roots = raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => path.resolve(r.replace(/^~/, process.env.HOME ?? "~")));
  return roots.some((root) => resolvedPath === root || resolvedPath.startsWith(root + path.sep));
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

async function checkoutRef(sourceRef?: string, authEnv?: NodeJS.ProcessEnv): Promise<void> {
  const ref = sourceRef?.trim();
  if (!ref) return;
  const fetchOk = await gitFetchWithRetry(["fetch", "--depth=1", "origin", ref], { authEnv });
  const remoteRef = await git(["rev-parse", "--verify", `origin/${ref}`], { allowFail: true });
  if (remoteRef) {
    if (!fetchOk) {
      // The fetch failed but a cached origin/<ref> exists from a prior run. We
      // ground on it rather than failing the stage — but NOT silently: the base
      // may be stale, so code context might not reflect the latest remote.
      console.warn(
        `[source-materializer] fetch of origin/${ref} failed; grounding on a CACHED, possibly STALE base ` +
        `${remoteRef.slice(0, 12)} — code context may not reflect the latest remote.`,
      );
    }
    await git(["checkout", "-B", ref.replace(/[^a-zA-Z0-9._/-]+/g, "-"), `origin/${ref}`]);
    return;
  }
  const fetched = await git(["rev-parse", "--verify", "FETCH_HEAD"], { allowFail: true });
  if (fetched) {
    await git(["checkout", "--detach", "FETCH_HEAD"]);
    return;
  }
  // No cached ref AND nothing fetched. If the fetch failed, fail loudly rather
  // than leaving the workspace on whatever happened to be checked out — a silent
  // stale/empty base is the exact failure mode this guards against.
  if (!fetchOk) {
    throw new Error(`unable to fetch ref '${ref}' from origin and no cached copy is available`);
  }
}

async function cloneIntoWorkspace(cloneUrl: string, sourceRef?: string, authEnv?: NodeJS.ProcessEnv): Promise<void> {
  const root = sandboxRoot();
  await removeWorkspaceContents(root);
  // `--template=` (empty) disables git's template-copy step. Without it,
  // re-running `git init` over a sandbox root whose .git/hooks/*.sample
  // entries are still visible — a stale-readdir race on the macOS Docker
  // bind-mount that lingers even right after removeWorkspaceContents() —
  // aborts with `fatal: cannot copy '.../hooks/pre-push.sample' ... File
  // exists`, failing materialization for the entire stage (observed on a
  // SECURITY_REVIEW run: find_symbol → WORKSPACE_MATERIALIZATION_FAILED).
  // The sample hooks are inert, so skipping the copy is free.
  await initRepoAtRoot(root);
  await git(["remote", "remove", "origin"], { cwd: root, allowFail: true });
  await git(["remote", "add", "origin", cloneUrl], { cwd: root });
  const ref = sourceRef?.trim();
  if (ref) {
    try {
      if (!(await gitFetchWithRetry(["fetch", "--depth=1", "origin", ref], { cwd: root, authEnv }))) {
        throw new Error(`fetch of ref '${ref}' from origin failed after retries`);
      }
      await checkoutRef(ref, authEnv);
    } catch {
      await removeWorkspaceContents(root);
      await initRepoAtRoot(root);
      await git(["remote", "add", "origin", cloneUrl], { cwd: root });
      if (!(await gitFetchWithRetry(["fetch", "--depth=1", "origin"], { cwd: root, authEnv }))) {
        throw new Error("failed to fetch default branch from origin after retries");
      }
      await git(["checkout", "-B", "main", "FETCH_HEAD"], { cwd: root });
    }
  } else {
    if (!(await gitFetchWithRetry(["fetch", "--depth=1", "origin"], { cwd: root, authEnv }))) {
      throw new Error("failed to fetch default branch from origin after retries");
    }
    await git(["checkout", "-B", "main", "FETCH_HEAD"], { cwd: root });
  }
}

async function gitBare(
  gitDir: string,
  args: string[],
  opts?: { allowFail?: boolean; maxBuffer?: number; authEnv?: NodeJS.ProcessEnv },
): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["--git-dir", gitDir, ...args], {
      cwd: path.dirname(gitDir),
      env: {
        ...process.env,
        ...(opts?.authEnv ?? {}),
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: SOURCE_MATERIALIZER_GIT_TIMEOUT_MS,
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
  opts?: { cwd?: string; allowFail?: boolean; maxBuffer?: number; authEnv?: NodeJS.ProcessEnv },
): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd: opts?.cwd ?? baseSandboxRoot(),
      env: {
        ...process.env,
        ...(opts?.authEnv ?? {}),
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: SOURCE_MATERIALIZER_GIT_TIMEOUT_MS,
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

async function ensureMirror(cloneUrl: string, authEnv?: NodeJS.ProcessEnv): Promise<string> {
  const cacheRoot = sourceCacheRoot();
  const mirror = sourceCachePath(cloneUrl);
  await fs.promises.mkdir(cacheRoot, { recursive: true });
  const hasHead = Boolean(await fs.promises.stat(path.join(mirror, "HEAD")).catch(() => null));
  if (!hasHead) {
    await fs.promises.rm(mirror, { recursive: true, force: true });
    await gitRaw(["clone", "--mirror", cloneUrl, mirror], { cwd: cacheRoot, maxBuffer: 60 * 1024 * 1024, authEnv });
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
    // Replace `+refs/*:refs/*` (set by clone --mirror) with the
    // standard remote-tracking refspec. See longer comment in the
    // else-branch below for the full rationale — TL;DR fixes the
    // "refusing to fetch into checked-out branch" failure mode that
    // silently freezes the mirror at clone-time forever.
    await gitBare(mirror, [
      "config", "--replace-all", "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    ], { allowFail: true });
    return mirror;
  }
  // Idempotent self-heal: even if this mirror was created by a prior
  // (pre-M70.6) build that didn't unset the mirror flag, fix it now
  // so the next push succeeds. allowFail covers the case where the
  // flag is already unset.
  await gitBare(mirror, ["config", "--unset", "remote.origin.mirror"], { allowFail: true });
  await gitBare(mirror, ["remote", "set-url", "origin", cloneUrl], { allowFail: true });
  // Bugfix (2026-05-26) — `git clone --mirror` originally configured
  // the fetch refspec as `+refs/*:refs/*`, which fetches the remote's
  // `refs/heads/main` directly into the local `refs/heads/main`. Once
  // the mirror's HEAD is symbolic-ref'd to refs/heads/main (which
  // happens on non-bare mirrors), git refuses every subsequent
  // `git fetch origin` with:
  //     fatal: refusing to fetch into branch 'refs/heads/main'
  //            checked out at '...'
  // `allowFail: true` swallows the error and the mirror silently
  // stays frozen at whatever commit it was created with. New
  // per-attempt worktrees branch from that frozen commit forever,
  // so upstream fixes never reach agents — exactly the bug that
  // burned the RuleEngine WI's testIsNotNull on 2026-05-26.
  // Fix: replace the refspec with the standard remote-tracking shape.
  // Fetches now write to refs/remotes/origin/* (which is what
  // resolveMirrorCommit prefers anyway, see line 237), bypassing the
  // checked-out branch. Idempotent self-heal — safe to run on every
  // ensureMirror call, fixes old mirrors created with the bad config.
  await gitBare(mirror, [
    "config", "--replace-all", "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  ], { allowFail: true });
  await gitBare(mirror, ["fetch", "--prune", "origin"], { allowFail: true, maxBuffer: 60 * 1024 * 1024, authEnv });
  return mirror;
}

async function resolveMirrorCommit(mirror: string, sourceRef?: string, authEnv?: NodeJS.ProcessEnv): Promise<string> {
  const ref = sourceRef?.trim();
  if (ref) {
    await gitBare(mirror, ["fetch", "--prune", "origin", ref], { allowFail: true, maxBuffer: 60 * 1024 * 1024, authEnv });
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

async function materializeGitWorktreeFromCache(cloneUrl: string, sourceRef?: string, authEnv?: NodeJS.ProcessEnv): Promise<void> {
  const root = sandboxRoot();
  if (path.resolve(root) === baseSandboxRoot()) {
    throw new Error("Shared git cache worktrees require a per-run workspace root.");
  }
  const mirror = await ensureMirror(cloneUrl, authEnv);
  const commit = await resolveMirrorCommit(mirror, sourceRef, authEnv);
  await gitBare(mirror, ["worktree", "prune"], { allowFail: true });
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(root), { recursive: true });
  await gitBare(mirror, ["worktree", "add", "--detach", "--force", root, commit], { maxBuffer: 60 * 1024 * 1024 });
}

/**
 * M81 P1 (2026-05-26) — Long-lived workitem branch resolution.
 *
 * After the worktree is created (or re-checked-out), align its HEAD with the
 * workitem branch:
 *
 *   1. `git fetch origin` to refresh the source-cache mirror.
 *   2. If `refs/remotes/origin/<branch>` exists, check it out — picks up
 *      prior commits from this workitem (continuity across machines / cache
 *      wipes / session resets).
 *   3. Otherwise look for a local branch in the source-cache mirror with the
 *      same name — covers the case where the branch was created previously
 *      but never pushed.
 *   4. Otherwise create a new local branch off the current commit (which is
 *      already on sourceRef per resolveMirrorCommit's work).
 *
 * Returns the origin of the branch so the audit/UI can distinguish "fresh
 * workitem" from "resumed workitem".
 */
async function alignWorkitemBranch(
  workitemBranch: string,
): Promise<"remote" | "local-cache" | "created-from-source-ref"> {
  // Best-effort fetch — failures here aren't fatal; if the remote is
  // unreachable we just continue with whatever the local cache has.
  await git(["fetch", "--prune", "origin", workitemBranch], { allowFail: true });
  await git(["fetch", "--prune", "origin"], { allowFail: true });

  // Existing local branch? (carries forward from prior local-only commits.)
  const localExists = await git(
    ["rev-parse", "--verify", `refs/heads/${workitemBranch}`],
    { allowFail: true },
  );

  // Tracking ref present (remote has it).
  const remoteExists = await git(
    ["rev-parse", "--verify", `refs/remotes/origin/${workitemBranch}`],
    { allowFail: true },
  );

  if (remoteExists) {
    // M89.d (2026-05-27) — the original comment here was: "Reset hard
    // onto the remote tip so we don't accidentally carry stale local
    // state. The worktree was just freshly created so there's nothing
    // to lose." That assumption was wrong. ensureWorkspaceSource runs
    // on EVERY /mcp/tool-run dispatch (see tool-run.ts:258), not just
    // at session start. The hard reset therefore wiped the agent's
    // in-flight edits between consecutive tool calls — repro from
    // attempt 087ac35a where Sonnet's replace_text dispatches landed
    // and then got reverted by the next tool-run's alignment pass.
    //
    // Now: when the worktree is already on the right branch and HAS
    // dirty paths, LEAVE THEM ALONE. The dirty changes are the
    // agent's pending edits; finish_work_branch will commit them.
    // Only reset when (a) we're switching to this branch fresh, or
    // (b) the worktree is clean (no edits to preserve).
    if (localExists) {
      const currentBranch = (
        await git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true })
      ).trim();
      const alreadyOnBranch = currentBranch === workitemBranch;
      const dirty = await dirtyPaths();
      if (alreadyOnBranch && dirty.length > 0) {
        // Preserve in-flight edits. Skip both checkout and reset.
        return "remote";
      }
      await git(["checkout", workitemBranch], { allowFail: true });
      if (dirty.length === 0) {
        // Clean worktree → safe to reset to remote tip and pick up
        // any new commits pushed by another caller.
        await git(["reset", "--hard", `origin/${workitemBranch}`], { allowFail: true });
      }
      // (If we got here with dirty=true but switched branches, the
      // checkout above will have refused the switch when files
      // conflict; either way we don't blow away the user's edits.)
    } else {
      await git(["checkout", "-B", workitemBranch, `origin/${workitemBranch}`], { allowFail: true });
    }
    return "remote";
  }
  if (localExists) {
    await git(["checkout", workitemBranch], { allowFail: true });
    return "local-cache";
  }
  // Fresh start — branch off whatever HEAD points at (which is the resolved
  // sourceRef commit per resolveMirrorCommit's earlier work).
  await git(["checkout", "-b", workitemBranch], { allowFail: true });
  return "created-from-source-ref";
}

async function materializeGitSource(cloneUrl: string, sourceRef?: string, authEnv?: NodeJS.ProcessEnv): Promise<string> {
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
    await materializeGitWorktreeFromCache(cloneUrl, sourceRef, authEnv);
    return "workspace source materialized from shared git cache";
  } catch {
    await cloneIntoWorkspace(cloneUrl, sourceRef, authEnv);
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
  await initRepoAtRoot(root, { allowFail: true });
}

async function configureGitIdentity(): Promise<void> {
  await git(["config", "user.email", "mcp@local"], { allowFail: true });
  await git(["config", "user.name", "MCP Server"], { allowFail: true });
}

// M-fix (cwd race) — serialize materialization per sandbox root. Two concurrent
// flows targeting the SAME root race: one's removeWorkspaceContents()/init can
// clear the directory while the other is mid-clone, yanking git's cwd. Keyed by
// the resolved sandbox root, so different work-item roots still materialize in
// parallel. mcp-server is a single Node process, so an in-process mutex is
// sufficient. The chain swallows prior errors (.catch) so one failed
// materialization doesn't poison the next caller for the same root.
const materializeLocks = new Map<string, Promise<unknown>>();

export async function ensureWorkspaceSource(
  req: WorkspaceSourceRequest,
  correlation?: CorrelationIds,
): Promise<WorkspaceSourceStatus | null> {
  if (!config.MCP_AUTO_CHECKOUT_SOURCE) return null;
  const key = path.resolve(sandboxRoot());
  const prior = materializeLocks.get(key) ?? Promise.resolve();
  const run = prior.catch(() => {}).then(() => ensureWorkspaceSourceImpl(req, correlation));
  materializeLocks.set(key, run);
  try {
    return await run;
  } finally {
    // Only clear if no newer caller has chained on (avoid dropping a queued run).
    if (materializeLocks.get(key) === run) materializeLocks.delete(key);
  }
}

async function ensureWorkspaceSourceImpl(
  req: WorkspaceSourceRequest,
  correlation?: CorrelationIds,
): Promise<WorkspaceSourceStatus | null> {
  const sourceType = req.sourceType?.trim().toLowerCase();
  const sourceUri = req.sourceUri?.trim();
  if (!sourceUri) return null;

  // P0 #2 — when a brokered clone credential is present, build the askpass env
  // ONCE here and thread it (as a parameter only — never module state) into every
  // network git call below so concurrent materializations of different repos
  // never share a token. Absent ⇒ undefined ⇒ git falls back to the static
  // GITHUB_TOKEN (current behavior). Used in-memory; discarded when this returns.
  const authEnv = req.gitToken ? await gitAskpassEnv(req.gitToken) : undefined;

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
    // #23 — resolve (defeats `..` traversal) + enforce the local-source allowlist
    // before touching the filesystem.
    const resolvedLocal = path.resolve(localPath);
    if (!localSourceRootAllowed(resolvedLocal)) {
      return {
        checkedOut: false,
        sourceType,
        sourceUri,
        sourceRef: req.sourceRef,
        workspaceRoot: sandboxRoot(),
        message: `Local source path is not within an allowed root (set MCP_ALLOWED_LOCAL_SOURCE_ROOTS): ${resolvedLocal}`,
      };
    }
    const stat = await fs.promises.stat(resolvedLocal).catch(() => null);
    if (!stat?.isDirectory()) {
      return {
        checkedOut: false,
        sourceType,
        sourceUri,
        sourceRef: req.sourceRef,
        workspaceRoot: sandboxRoot(),
        message: `Local source path was not found or is not a directory: ${resolvedLocal}`,
      };
    }
    let message = "local workspace source materialized";
    if (fs.existsSync(path.join(resolvedLocal, ".git"))) {
      message = await materializeGitSource(resolvedLocal, req.sourceRef, authEnv);
    } else {
      await copyLocalDirectoryIntoWorkspace(resolvedLocal);
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

  const message = await materializeGitSource(cloneUrl, req.sourceRef, authEnv);
  await configureGitIdentity();

  // (M81 P1) — when a workitemBranch is requested, align HEAD with it so
  // every subsequent tool call (read/edit/commit) operates on the branch.
  // Skip when missing for backward compat (old callers still get the
  // detached-HEAD behavior).
  let workitemBranchOrigin: WorkspaceSourceStatus["workitemBranchOrigin"];
  const branch = req.workitemBranch?.trim();
  if (branch) {
    try {
      workitemBranchOrigin = await alignWorkitemBranch(branch);
    } catch (err) {
      // Branch alignment is best-effort. If git refuses (eg, branch name
      // collides with a path), surface in status but don't fail the
      // materialization — the worktree is still usable in detached state.
      // eslint-disable-next-line no-console
      console.warn(`[source-materializer] alignWorkitemBranch failed: ${(err as Error).message}`);
    }
  }

  const status: WorkspaceSourceStatus = {
    checkedOut: true,
    sourceType,
    sourceUri,
    sourceRef: req.sourceRef,
    remoteUrl: await currentRemote(),
    headSha: await currentHead(),
    workspaceRoot: sandboxRoot(),
    message,
    workitemBranch: branch,
    workitemBranchOrigin,
  };
  events.publish({
    kind: "workspace.source.checked_out",
    correlation: correlation ?? { mcpInvocationId: "workspace" },
    payload: { ...status },
  });
  return status;
}
