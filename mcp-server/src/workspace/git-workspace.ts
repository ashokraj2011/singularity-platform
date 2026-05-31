import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { config } from "../config";
import { events } from "../events/bus";
import type { CorrelationIds } from "../audit/store";
import { redactSecrets } from "../security/redact";
import { sandboxRoot } from "./sandbox";

const execFileP = promisify(execFile);

export interface BranchRequest {
  workflowInstanceId?: string;
  nodeId?: string;
  workItemId?: string;
  workItemCode?: string;
  branchBase?: string;
  branchName?: string;
}

export interface WorkBranchInfo {
  branch: string;
  baseBranch?: string;
  headSha?: string;
  workspaceRoot?: string;
  reused: boolean;
}

export interface FinishBranchResult {
  branch: string;
  commitSha?: string;
  changedPaths: string[];
  patch?: string;
  workspaceRoot?: string;
  committed: boolean;
  message: string;
  /** M27.5 — set only when caller asked for `push: true`. */
  pushed?: boolean;
  /** M27.5 — non-empty when the push attempt failed but the local commit succeeded. */
  pushError?: string;
  pushBlockedCode?: "GIT_AUTH_MISSING" | "GIT_AUTH_INSUFFICIENT_SCOPE" | "GIT_REMOTE_UNREACHABLE" | "GIT_PUSH_REJECTED" | "NO_COMMIT_TO_PUSH"
    // M99 S1.4 — discrete codes that previously collapsed into the buckets
    // above. Splitting them out lets git_push_preflight (S1.3) and
    // GitPushExecutor surface precise, actionable fix guidance.
    | "GIT_BRANCH_PROTECTED" | "GIT_NO_UPSTREAM" | "GIT_REMOTE_MISMATCH";
  pushFixCommands?: string[];
  pushRetryable?: boolean;
  pushRemote?: string;
  formalVerification?: FormalVerificationReceipt;
  formalVerificationBlocked?: boolean;
}

let activeBranch: WorkBranchInfo | null = null;

export interface FormalVerificationReceipt {
  kind: "verification_result";
  verification_kind: "formal";
  enabled: boolean;
  passed: boolean;
  result: "UNSAT" | "SAT" | "UNKNOWN" | "SKIPPED" | "ERROR" | string;
  riskLevel?: string;
  requestId?: string;
  resultId?: string;
  receiptId?: string;
  counterexample?: unknown;
  explanation?: string;
  recommendations?: unknown[];
  solver?: unknown;
  hashes?: unknown;
  payload?: Record<string, unknown>;
  error?: string;
  duration_ms?: number;
}

function safePart(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .replace(/\/+/g, "/");
  return cleaned || fallback;
}

export function branchNameForWork(req: BranchRequest): string | null {
  if (req.branchName) return safePart(req.branchName, "work").slice(0, 180);
  const workIdentity = req.workItemCode || req.workItemId;
  if (!req.workflowInstanceId || !req.nodeId || !workIdentity) return null;
  const prefix = safePart(config.MCP_WORK_BRANCH_PREFIX, "sg");
  return [
    prefix,
    safePart(req.workflowInstanceId, "workflow").slice(0, 36),
    safePart(req.nodeId, "node").slice(0, 36),
    safePart(workIdentity, "work").slice(0, 36),
  ].join("/").slice(0, 180);
}

async function git(args: string[], opts?: { allowFail?: boolean; maxBuffer?: number; env?: NodeJS.ProcessEnv }): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd: sandboxRoot(),
      maxBuffer: opts?.maxBuffer ?? 10 * 1024 * 1024,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    });
    return stdout.trim();
  } catch (err) {
    if (opts?.allowFail) return "";
    throw err;
  }
}

async function gitPath(relativePath: string): Promise<string> {
  const resolved = await git(["rev-parse", "--git-path", relativePath]);
  return path.isAbsolute(resolved) ? resolved : path.join(sandboxRoot(), resolved);
}

export async function applyPatchToCleanWorkspace(patch: string): Promise<{ applied: boolean; skippedReason?: string }> {
  const trimmedPatch = patch.trim();
  if (!trimmedPatch) return { applied: false, skippedReason: "empty patch" };

  await ensureGitRepo();
  const dirty = await dirtyPaths();
  if (dirty.length > 0) {
    return { applied: false, skippedReason: `workspace has uncommitted changes: ${dirty.join(", ")}` };
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "singularity-patch-"));
  const patchFile = path.join(tempDir, "approved.patch");
  await fs.promises.writeFile(patchFile, patch.endsWith("\n") ? patch : `${patch}\n`, "utf8");
  try {
    try {
      await git(["apply", "--check", patchFile], { maxBuffer: 20 * 1024 * 1024 });
      await git(["apply", "--whitespace=nowarn", patchFile], { maxBuffer: 20 * 1024 * 1024 });
      return { applied: true };
    } catch (err) {
      try {
        await git(["apply", "--reverse", "--check", patchFile], { maxBuffer: 20 * 1024 * 1024 });
        return { applied: false, skippedReason: "patch already present in workspace" };
      } catch {
        throw err;
      }
    }
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

type PushBlockedCode = NonNullable<FinishBranchResult["pushBlockedCode"]>;
type PushResult = {
  pushed: boolean;
  pushError?: string;
  remote: string;
  blockedCode?: PushBlockedCode;
  fixCommands?: string[];
  retryable?: boolean;
};

function isPushResult(value: NodeJS.ProcessEnv | PushResult): value is PushResult {
  return typeof (value as PushResult).pushed === "boolean";
}

// Exported for unit tests (test/classify-push-error.test.ts). Pure
// functions — no I/O — safe to import directly.
export function fixCommandsForPushBlock(code: PushBlockedCode, remote: string): string[] {
  if (code === "GIT_AUTH_MISSING") {
    if (config.MCP_GIT_AUTH_MODE === "ssh") {
      return [
        "./singularity.sh config git --mode ssh --ssh-key ~/.ssh/id_ed25519 --remote " + remote,
        "./singularity.sh doctor git",
        "./singularity.sh restart mcp-server-demo",
      ];
    }
    return [
      "export GITHUB_TOKEN=<github-token-with-repo-write>",
      "./singularity.sh config git --mode token --token-env GITHUB_TOKEN --remote " + remote,
      "./singularity.sh doctor git",
      "./singularity.sh restart mcp-server-demo",
    ];
  }
  // M70.8 — Distinct guidance for "token works but doesn't have the right
  // scope" vs. "no token at all". The classic GIT_AUTH_MISSING path
  // implied 'set up auth from scratch'; that's wrong when the operator
  // ALREADY has a token configured and GitHub is just refusing it. Now
  // we point them at the specific token-edit page and explicit Contents:
  // Write requirement instead of telling them to start over.
  if (code === "GIT_AUTH_INSUFFICIENT_SCOPE") {
    return [
      "Your git token is authenticated but lacks Contents: Write on this repo.",
      "Fine-grained PAT (token starts with github_pat_...): https://github.com/settings/tokens?type=beta — edit the token, ensure the repo is in 'Selected repositories', and set Repository permissions > Contents = Read and write.",
      "Classic PAT: https://github.com/settings/tokens — regenerate with the `repo` scope (full).",
      "./singularity.sh restart mcp-server-demo  # picks up the new token from .env",
    ];
  }
  if (code === "GIT_REMOTE_UNREACHABLE") {
    return [
      "git remote -v",
      "git remote set-url " + remote + " <ssh-or-https-repo-url>",
      "./singularity.sh doctor git",
    ];
  }
  if (code === "NO_COMMIT_TO_PUSH") {
    return [
      "Re-run the Developer stage with a writable MCP workspace.",
      "Approve the captured code diff, then retry Git Push.",
    ];
  }
  // M99 S1.4 — discrete codes split out of the generic GIT_PUSH_REJECTED bucket.
  if (code === "GIT_BRANCH_PROTECTED") {
    return [
      "The target branch is protected — a direct push is refused by branch protection.",
      "Push your work to a feature branch (e.g. wi/<code>) and open a Pull Request to merge it.",
      "If a direct push is required, an admin must relax the branch-protection rule for this branch.",
    ];
  }
  if (code === "GIT_NO_UPSTREAM") {
    return [
      "The local branch has no upstream tracking ref on " + remote + ".",
      "git push -u " + remote + " <branch>   # sets the upstream on first push",
    ];
  }
  if (code === "GIT_REMOTE_MISMATCH") {
    return [
      "Local and remote histories are unrelated — the configured remote likely points at a different repo than this work is based on.",
      "git remote -v   # confirm " + remote + " matches the work item's source repo URL",
      "git remote set-url " + remote + " <correct-repo-url>   # if the remote is wrong",
    ];
  }
  return [
    "Inspect the remote rejection, update/rebase the work branch if needed, then retry Git Push.",
    "./singularity.sh doctor git",
  ];
}

export function classifyPushError(error: string): PushBlockedCode {
  const lower = error.toLowerCase();
  // M70.8 — GitHub-specific "token authenticated, scope insufficient"
  // path. The error string from `git push` to GitHub when the PAT
  // lacks Contents: Write looks like:
  //   remote: Permission to ashokraj2011/RuleEngine.git denied to ashokraj2011.
  //   fatal: unable to access 'https://github.com/ashokraj2011/RuleEngine.git/': The requested URL returned error: 403
  // The pre-M70.8 classifier looked for the contiguous string
  // "permission denied" — but GitHub's wording is "Permission to X
  // denied to Y", which doesn't match. So we fell through to the
  // generic GIT_PUSH_REJECTED and the operator got "Inspect the
  // remote rejection" — unhelpful. Detect the GitHub shape explicitly
  // and route to the new GIT_AUTH_INSUFFICIENT_SCOPE code which has
  // token-scope-specific fix steps.
  // M99 S1.4 — protected branch. Checked FIRST: branch-protection
  // rejections often also contain "denied"/"403", which would otherwise
  // be misclassified as an auth-scope problem. The remedy is different
  // (open a PR / push a feature branch, not widen the token). GH006 is
  // GitHub's explicit protected-branch code. Deliberately NARROW — we do
  // NOT match a bare "pre-receive hook declined" because that also covers
  // GH013 repository-rule violations, which stay GIT_PUSH_REJECTED.
  if (
    lower.includes("protected branch")
    || lower.includes("cannot force-push to a protected")
    || lower.includes("gh006")
    || lower.includes("branch is read-only")
  ) {
    return "GIT_BRANCH_PROTECTED";
  }
  if (
    /permission to .+ denied to /i.test(error)
    || (lower.includes("requested url returned error: 403") && lower.includes("github.com"))
    || lower.includes("write access to the repository is not granted")
  ) {
    return "GIT_AUTH_INSUFFICIENT_SCOPE";
  }
  if (
    lower.includes("could not read username")
    || lower.includes("authentication failed")
    || lower.includes("permission denied")
    || lower.includes("could not read from remote repository")
    || lower.includes("repository not found")
  ) {
    return "GIT_AUTH_MISSING";
  }
  // M99 S1.4 — no upstream tracking ref configured for the local branch.
  if (
    lower.includes("has no upstream branch")
    || lower.includes("--set-upstream")
    || lower.includes("no upstream configured")
  ) {
    return "GIT_NO_UPSTREAM";
  }
  if (
    lower.includes("remote") && (
      lower.includes("not configured")
      || lower.includes("could not resolve host")
      || lower.includes("not found")
      || lower.includes("does not appear to be a git repository")
    )
  ) {
    return "GIT_REMOTE_UNREACHABLE";
  }
  // M99 S1.4 — remote mismatch: local + remote histories are unrelated
  // (the configured remote points at a different repo than the work was
  // based on). Kept NARROW — only "unrelated histories" — so the common
  // non-fast-forward "remote contains work" case stays GIT_PUSH_REJECTED.
  if (
    lower.includes("refusing to merge unrelated histories")
    || lower.includes("unrelated histories")
  ) {
    return "GIT_REMOTE_MISMATCH";
  }
  return "GIT_PUSH_REJECTED";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function ensureAskPassScript(): Promise<string> {
  const script = await gitPath("singularity/git-askpass.sh");
  const dir = path.dirname(script);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    script,
    "#!/usr/bin/env sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"${SINGULARITY_GIT_USERNAME:-x-access-token}\" ;;\n  *) printf '%s\\n' \"${SINGULARITY_GIT_TOKEN:-}\" ;;\nesac\n",
    { mode: 0o700 },
  );
  return script;
}

async function gitAuthEnv(): Promise<NodeJS.ProcessEnv | PushResult> {
  if (!config.MCP_GIT_PUSH_ENABLED || config.MCP_GIT_AUTH_MODE === "disabled") {
    return {
      pushed: false,
      remote: config.MCP_GIT_PUSH_REMOTE,
      pushError: "Git push is disabled. Configure Git credentials before publishing WorkItem branches.",
      blockedCode: "GIT_AUTH_MISSING",
      fixCommands: fixCommandsForPushBlock("GIT_AUTH_MISSING", config.MCP_GIT_PUSH_REMOTE),
      retryable: true,
    };
  }

  if (config.MCP_GIT_AUTH_MODE === "token") {
    const token = process.env[config.MCP_GIT_TOKEN_ENV] || config.MCP_GIT_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
      return {
        pushed: false,
        remote: config.MCP_GIT_PUSH_REMOTE,
        pushError: `Git token env '${config.MCP_GIT_TOKEN_ENV}' is not available inside MCP.`,
        blockedCode: "GIT_AUTH_MISSING",
        fixCommands: fixCommandsForPushBlock("GIT_AUTH_MISSING", config.MCP_GIT_PUSH_REMOTE),
        retryable: true,
      };
    }
    return {
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: await ensureAskPassScript(),
      SINGULARITY_GIT_USERNAME: config.MCP_GIT_USERNAME,
      SINGULARITY_GIT_TOKEN: token,
    };
  }

  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
  };
  if (config.MCP_GIT_SSH_KEY_PATH) {
    try {
      const stat = await fs.promises.stat(config.MCP_GIT_SSH_KEY_PATH);
      if (!stat.isFile()) {
        return {
          pushed: false,
          remote: config.MCP_GIT_PUSH_REMOTE,
          pushError: `Configured SSH key path is not a file: ${config.MCP_GIT_SSH_KEY_PATH}`,
          blockedCode: "GIT_AUTH_MISSING",
          fixCommands: fixCommandsForPushBlock("GIT_AUTH_MISSING", config.MCP_GIT_PUSH_REMOTE),
          retryable: true,
        };
      }
      env.GIT_SSH_COMMAND = `ssh -i ${shellQuote(config.MCP_GIT_SSH_KEY_PATH)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    } catch {
      return {
        pushed: false,
        remote: config.MCP_GIT_PUSH_REMOTE,
        pushError: `Configured SSH key path is not readable: ${config.MCP_GIT_SSH_KEY_PATH}`,
        blockedCode: "GIT_AUTH_MISSING",
        fixCommands: fixCommandsForPushBlock("GIT_AUTH_MISSING", config.MCP_GIT_PUSH_REMOTE),
        retryable: true,
      };
    }
  }
  return env;
}

async function pushBranch(branch: string, remote?: string): Promise<PushResult> {
  const resolvedRemote = remote?.trim() || config.MCP_GIT_PUSH_REMOTE || "origin";
  const auth = await gitAuthEnv();
  if (isPushResult(auth)) {
    return { ...auth, remote: resolvedRemote, fixCommands: auth.fixCommands ?? fixCommandsForPushBlock(auth.blockedCode ?? "GIT_AUTH_MISSING", resolvedRemote) };
  }
  try {
    const hasRemote = Boolean(await git(["remote", "get-url", resolvedRemote], { allowFail: true, env: auth }));
    if (!hasRemote) {
      return {
        pushed: false,
        pushError: `remote '${resolvedRemote}' is not configured`,
        remote: resolvedRemote,
        blockedCode: "GIT_REMOTE_UNREACHABLE",
        fixCommands: fixCommandsForPushBlock("GIT_REMOTE_UNREACHABLE", resolvedRemote),
        retryable: true,
      };
    }
    await git(["push", "--dry-run", "-u", resolvedRemote, branch], { maxBuffer: 10 * 1024 * 1024, env: auth });
    await git(["push", "-u", resolvedRemote, branch], { maxBuffer: 10 * 1024 * 1024, env: auth });
    return { pushed: true, remote: resolvedRemote, retryable: false };
  } catch (err) {
    const pushError = redactSecrets((err as Error).message);
    const blockedCode = classifyPushError(pushError);
    return {
      pushed: false,
      pushError,
      remote: resolvedRemote,
      blockedCode,
      fixCommands: fixCommandsForPushBlock(blockedCode, resolvedRemote),
      retryable: blockedCode !== "NO_COMMIT_TO_PUSH",
    };
  }
}

function pushFields(push: PushResult | undefined): Pick<FinishBranchResult, "pushed" | "pushError" | "pushBlockedCode" | "pushFixCommands" | "pushRetryable" | "pushRemote"> {
  return {
    pushed: push?.pushed,
    pushError: push?.pushError ? redactSecrets(push.pushError) : undefined,
    pushBlockedCode: push?.blockedCode,
    pushFixCommands: push?.fixCommands,
    pushRetryable: push?.retryable,
    pushRemote: push?.remote,
  };
}

function noCommitPushResult(push: PushResult | undefined): Partial<FinishBranchResult> {
  if (!push) return {};
  if (push.pushed) return pushFields(push);
  if (!push.blockedCode) return pushFields(push);
  return {
    ...pushFields(push),
    pushBlockedCode: push.blockedCode,
    pushRetryable: true,
  };
}

async function pushExistingBranch(branch: string, options?: FinishBranchOptions): Promise<Partial<FinishBranchResult>> {
  if (!options?.push) return {};
  const commitSha = await currentHeadSha();
  if (!commitSha) {
    return {
      pushed: false,
      pushError: "No commit is available to push from this workspace branch.",
      pushBlockedCode: "NO_COMMIT_TO_PUSH",
      pushFixCommands: fixCommandsForPushBlock("NO_COMMIT_TO_PUSH", options.remote ?? config.MCP_GIT_PUSH_REMOTE ?? "origin"),
      pushRetryable: true,
      pushRemote: options.remote ?? config.MCP_GIT_PUSH_REMOTE ?? "origin",
    };
  }
  return noCommitPushResult(await pushBranch(branch, options.remote));
}

function pushMessage(push: Partial<FinishBranchResult> | undefined, pushedText: string, failedText: string): string {
  if (!push || push.pushed === undefined) return failedText;
  if (push.pushed) return pushedText;
  if (push.pushBlockedCode === "NO_COMMIT_TO_PUSH") return "no commit to push";
  if (push.pushBlockedCode === "GIT_AUTH_MISSING") return "committed locally; push needs Git credentials";
  if (push.pushBlockedCode === "GIT_REMOTE_UNREACHABLE") return "committed locally; git remote is not reachable";
  return failedText;
}

export async function ensureGitRepo(): Promise<void> {
  await git(["init", "-q"]);
  await git(["config", "user.email", "mcp@local"]);
  await git(["config", "user.name", "MCP Server"]);
  await ensureLocalGitExcludes();
}

async function ensureLocalGitExcludes(): Promise<void> {
  const excludePath = await gitPath("info/exclude");
  await fs.promises.mkdir(path.dirname(excludePath), { recursive: true });
  const current = await fs.promises.readFile(excludePath, "utf8").catch(() => "");
  if (current.includes(".singularity/")) return;
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.promises.appendFile(excludePath, `${prefix}.singularity/\n`, "utf8");
}

export async function currentBranch(): Promise<string | undefined> {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });
  return branch && branch !== "HEAD" ? branch : undefined;
}

export async function currentHeadSha(): Promise<string | undefined> {
  return await git(["rev-parse", "HEAD"], { allowFail: true }) || undefined;
}

export function getActiveBranch(): WorkBranchInfo | null {
  return activeBranch;
}

export async function prepareWorkBranch(
  req: BranchRequest,
  correlation?: CorrelationIds,
): Promise<WorkBranchInfo | null> {
  const branch = branchNameForWork(req);
  if (!branch) return null;
  await ensureGitRepo();
  const exists = Boolean(await git(["show-ref", "--verify", `refs/heads/${branch}`], { allowFail: true }));
  const before = await currentBranch();
  if (exists) {
    await git(["checkout", branch]);
  } else if (req.branchBase) {
    await git(["checkout", "-B", branch, req.branchBase]);
  } else {
    await git(["checkout", "-B", branch]);
  }
  activeBranch = {
    branch,
    baseBranch: req.branchBase ?? before,
    headSha: await currentHeadSha(),
    workspaceRoot: sandboxRoot(),
    reused: exists,
  };
  events.publish({
    kind: "workspace.branch.created",
    correlation: correlation ?? { mcpInvocationId: "workspace" },
    payload: {
      branch,
      baseBranch: activeBranch.baseBranch,
      headSha: activeBranch.headSha,
      workspaceRoot: activeBranch.workspaceRoot,
      reused: exists,
    },
  });
  return activeBranch;
}

export async function dirtyPaths(): Promise<string[]> {
  await ensureGitRepo();
  const { stdout } = await execFileP("git", ["status", "--porcelain"], {
    cwd: sandboxRoot(),
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  }).catch(() => ({ stdout: "" }));
  const porcelain = String(stdout);
  return porcelain.split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const changedPath = line.slice(3).trim();
      const renameIndex = changedPath.lastIndexOf(" -> ");
      return renameIndex >= 0 ? changedPath.slice(renameIndex + 4).trim() : changedPath;
    })
    .filter(Boolean);
}

/**
 * M27.5 — re-establish the active work-branch after an mcp-server restart
 * without minting a fresh branch name. Called by /mcp/resume when the
 * consumed PendingApproval envelope carries a `workspace.branch` block.
 *
 * Pre-restart: prepareWorkBranch() created "sg/<wf>/<node>/<wi>" and
 * activeBranch is set in-memory. Process dies → in-memory state lost,
 * git tree is intact on disk. On resume we already have the persisted
 * branch identifier in the LoopState envelope; we just need to make
 * sure HEAD points at it again.
 *
 * Returns the live WorkBranchInfo (with refreshed headSha) on success,
 * or null when the persisted branch ref no longer exists locally (e.g.
 * sandbox switched between mcp-server invocations — see M27.5 followup
 * "AST index lifecycle when sandbox root changes mid-session").
 */
export async function restoreWorkBranch(
  persisted: WorkBranchInfo,
  correlation?: CorrelationIds,
): Promise<WorkBranchInfo | null> {
  await ensureGitRepo();
  const branch = persisted.branch;
  if (!branch) return null;
  const exists = Boolean(await git(["show-ref", "--verify", `refs/heads/${branch}`], { allowFail: true }));
  if (!exists) {
    if (persisted.baseBranch) {
      await git(["checkout", "-B", branch, persisted.baseBranch]);
    } else {
      await git(["checkout", "-B", branch]);
    }
  } else {
    const head = await currentBranch();
    if (head !== branch) await git(["checkout", branch]);
  }
  activeBranch = {
    branch,
    baseBranch: persisted.baseBranch,
    headSha: await currentHeadSha(),
    workspaceRoot: sandboxRoot(),
    reused: true,
  };
  events.publish({
    kind: "workspace.branch.created",
    correlation: correlation ?? { mcpInvocationId: "workspace" },
    severity: "info",
    payload: {
      branch,
      baseBranch: activeBranch.baseBranch,
      headSha: activeBranch.headSha,
      workspaceRoot: activeBranch.workspaceRoot,
      reused: true,
      restored: true,
      persistedHeadSha: persisted.headSha,
      drift: persisted.headSha && persisted.headSha !== activeBranch.headSha,
    },
  });
  return activeBranch;
}

export interface FinishBranchOptions {
  push?: boolean;
  remote?: string;
  verificationReceipts?: Array<Record<string, unknown>>;
}

export async function finishWorkBranch(
  message?: string,
  options?: FinishBranchOptions,
): Promise<FinishBranchResult> {
  await ensureGitRepo();
  const branch = await currentBranch() ?? getActiveBranch()?.branch ?? "main";
  const changedPaths = await dirtyPaths();
  if (changedPaths.length === 0) {
    const commitSha = await currentHeadSha();
    const push = options?.push ? await pushExistingBranch(branch, options) : undefined;
    return {
      branch,
      workspaceRoot: sandboxRoot(),
      commitSha,
      changedPaths: [],
      committed: false,
      ...push,
      message: options?.push
        ? pushMessage(push, "no changes to commit; pushed existing branch", "no changes to commit; push failed")
        : "no changes to commit",
    };
  }
  const patch = await git(["diff", "--binary"], { allowFail: true, maxBuffer: 20 * 1024 * 1024 });
  const formalVerification = await runFormalVerificationBeforeFinish({
    branch,
    changedPaths,
    patch,
    verificationReceipts: options?.verificationReceipts ?? [],
  });
  if (formalVerification && !formalVerification.passed) {
    return {
      branch,
      changedPaths,
      patch,
      workspaceRoot: sandboxRoot(),
      committed: false,
      message: formalVerification.error
        ? `formal verification failed: ${formalVerification.error}`
        : "formal verification blocked finish_work_branch",
      formalVerification,
      formalVerificationBlocked: true,
    };
  }
  await git(["add", "-A"]);
  const commitMessage = message?.trim() || `Singularity work item ${branch}`;
  await git(["commit", "-m", commitMessage], { maxBuffer: 20 * 1024 * 1024 });
  const commitSha = await currentHeadSha();
  const committedPatch = commitSha
    ? await git(["show", "--format=", commitSha], { allowFail: true, maxBuffer: 20 * 1024 * 1024 })
    : patch;

  const push = options?.push && commitSha
    ? await pushBranch(branch, options.remote)
    : undefined;

  try {
    const refsStdout = await git(["for-each-ref", "--format=%(refname)", "refs/singularity/checkpoints/"], { allowFail: true });
    for (const ref of refsStdout.split("\n").filter(Boolean)) {
      await git(["update-ref", "-d", ref], { allowFail: true });
    }
  } catch { /* ignored */ }

  return {
    branch,
    commitSha,
    changedPaths,
    patch: committedPatch || patch,
    workspaceRoot: sandboxRoot(),
    committed: true,
    message: commitMessage,
    formalVerification,
    ...pushFields(push),
  } as FinishBranchResult;
}

function verificationPassed(receipts: Array<Record<string, unknown>>): boolean {
  return receipts.length > 0 && receipts.every((receipt) => {
    if (receipt.passed === false) return false;
    const exitCode =
      typeof receipt.exit_code === "number" ? receipt.exit_code
      : typeof receipt.exitCode === "number" ? receipt.exitCode
      : undefined;
    if (exitCode !== undefined && exitCode !== 0) return false;
    if (receipt.passed === true || exitCode === 0) return true;
    return receipt.verification_kind === "formal" && String(receipt.result ?? "").toUpperCase() === "UNSAT";
  });
}

function highRiskChangedPaths(paths: string[]): string[] {
  return paths.filter((changedPath) => /(^|\/)(auth|security|policy|permission|iam|payment|billing|deploy|release|infra|docker|k8s|secret|config)/i.test(changedPath));
}

function formalPayloadForFinish(input: {
  branch: string;
  changedPaths: string[];
  patch: string;
  verificationReceipts: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const verificationReceiptPresent = input.verificationReceipts.length > 0;
  const verificationReceiptPassed = verificationPassed(input.verificationReceipts);
  const riskyPaths = highRiskChangedPaths(input.changedPaths);
  return {
    scope: "CODE_CHANGE_FINISH",
    facts: {
      codeChanged: input.changedPaths.length > 0,
      changedPathCount: input.changedPaths.length,
      changedPaths: input.changedPaths,
      highRiskChangedPathCount: riskyPaths.length,
      highRiskChangedPaths: riskyPaths,
      verificationReceiptPresent,
      verificationReceiptPassed,
      verificationReceiptCount: input.verificationReceipts.length,
      branch: input.branch,
    },
    constraints: [
      {
        id: "code_change_requires_verification_receipt",
        severity: "HIGH",
        description: "A code-changing branch must include at least one test/lint/typecheck/formal verification receipt before finish.",
        expr: {
          op: "IMPLIES",
          if: { field: "codeChanged", op: "==", value: true },
          then: { field: "verificationReceiptPresent", op: "==", value: true },
        },
      },
      {
        id: "code_change_requires_passing_verification",
        severity: "HIGH",
        description: "A code-changing branch must not finish with failed verification evidence.",
        expr: {
          op: "IMPLIES",
          if: { field: "codeChanged", op: "==", value: true },
          then: { field: "verificationReceiptPassed", op: "==", value: true },
        },
      },
    ],
    query: {
      op: "AND",
      args: [
        { field: "codeChanged", op: "==", value: true },
        {
          op: "OR",
          args: [
            { field: "verificationReceiptPresent", op: "==", value: false },
            { field: "verificationReceiptPassed", op: "==", value: false },
          ],
        },
      ],
    },
    options: { timeoutMs: config.FORMAL_VERIFICATION_TIMEOUT_MS },
    artifactRefs: [
      {
        type: "git_diff",
        changedPaths: input.changedPaths,
        patchChars: input.patch.length,
      },
      ...input.verificationReceipts.map((receipt, index) => ({
        type: "verification_receipt",
        index,
        command: receipt.command,
        passed: receipt.passed,
        exit_code: receipt.exit_code ?? receipt.exitCode,
        toolInvocationId: receipt.toolInvocationId,
      })),
    ],
    metadata: {
      generatedBy: "mcp-server",
      branch: input.branch,
      workspaceRoot: sandboxRoot(),
    },
  };
}

async function runFormalVerificationBeforeFinish(input: {
  branch: string;
  changedPaths: string[];
  patch: string;
  verificationReceipts: Array<Record<string, unknown>>;
}): Promise<FormalVerificationReceipt | undefined> {
  if (!config.FORMAL_VERIFICATION_ENABLED || input.changedPaths.length === 0) return undefined;
  const payload = formalPayloadForFinish(input);
  const started = Date.now();
  try {
    const res = await fetch(`${config.FORMAL_VERIFIER_URL.replace(/\/+$/, "")}/api/v1/verification/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.FORMAL_VERIFICATION_TIMEOUT_MS + 1_000),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      parsed = { message: text };
    }
    if (!res.ok) {
      return {
        kind: "verification_result",
        verification_kind: "formal",
        enabled: true,
        passed: false,
        result: "ERROR",
        error: String((parsed.detail as { message?: unknown } | undefined)?.message ?? parsed.message ?? `formal verifier returned HTTP ${res.status}`),
        payload,
        duration_ms: Date.now() - started,
      };
    }
    const result = String(parsed.result ?? "UNKNOWN").toUpperCase();
    const passed = result === "UNSAT" || (result === "UNKNOWN" && !config.FORMAL_VERIFICATION_BLOCK_ON_UNKNOWN);
    return {
      kind: "verification_result",
      verification_kind: "formal",
      enabled: true,
      passed,
      result,
      riskLevel: typeof parsed.riskLevel === "string" ? parsed.riskLevel : undefined,
      requestId: typeof parsed.requestId === "string" ? parsed.requestId : undefined,
      resultId: typeof parsed.resultId === "string" ? parsed.resultId : undefined,
      receiptId: typeof parsed.receiptId === "string" ? parsed.receiptId : undefined,
      counterexample: parsed.counterexample,
      explanation: typeof parsed.explanation === "string" ? parsed.explanation : undefined,
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : undefined,
      solver: parsed.solver,
      hashes: parsed.hashes,
      payload,
      duration_ms: Date.now() - started,
    };
  } catch (err) {
    return {
      kind: "verification_result",
      verification_kind: "formal",
      enabled: true,
      passed: false,
      result: "ERROR",
      error: (err as Error).message,
      payload,
      duration_ms: Date.now() - started,
    };
  }
}

/**
 * Creates a checkpoint ref capturing the current state of mutatedPaths only.
 * Does not advance HEAD or create visible commits.
 */
export async function createCheckpoint(
  mutatedPaths: string[],
  stepIndex: number,
  correlation: CorrelationIds
): Promise<{ ref: string; treeHash: string } | null> {
  if (mutatedPaths.length === 0) return null;
  await ensureGitRepo();

  // Stage only the mutated paths (not git add -A)
  await git(["add", "--", ...mutatedPaths]);

  // Write tree from staged content
  const treeHash = await git(["write-tree"]);

  // Create commit object without updating HEAD
  const hasCommit = Boolean(await git(["rev-parse", "--verify", "HEAD"], { allowFail: true }));
  const commitTreeArgs = ["commit-tree", treeHash.trim()];
  if (hasCommit) {
    commitTreeArgs.push("-p", "HEAD");
  }
  commitTreeArgs.push("-m", `checkpoint step=${stepIndex} run=${correlation.runId ?? "?"}`);
  const commitHash = await git(commitTreeArgs);

  // Store as ref under refs/singularity/checkpoints/
  const refName = `refs/singularity/checkpoints/${correlation.runId ?? "local"}/${stepIndex}`;
  await git(["update-ref", refName, commitHash.trim()]);

  // Reset staging area (leave working tree intact)
  if (hasCommit) {
    await git(["reset", "HEAD", "--", ...mutatedPaths]);
  } else {
    await git(["rm", "--cached", "-r", "--", ...mutatedPaths], { allowFail: true });
  }

  return { ref: refName, treeHash: treeHash.trim() };
}

/**
 * Roll back mutated files to a checkpoint state.
 */
export async function rollbackToCheckpoint(ref: string, paths?: string[]): Promise<void> {
  const cwd = sandboxRoot();
  const target = paths?.length ? ["--", ...paths] : ["--", "."];
  await execFileP("git", ["checkout", ref, ...target], { cwd });
}

/**
 * Clean up checkpoint refs for a completed run.
 */
export async function cleanupCheckpoints(runId: string): Promise<void> {
  const cwd = sandboxRoot();
  const prefix = `refs/singularity/checkpoints/${runId}/`;
  try {
    const { stdout } = await execFileP(
      "git", ["for-each-ref", "--format=%(refname)", prefix], { cwd }
    );
    for (const ref of stdout.trim().split("\n").filter(Boolean)) {
      await execFileP("git", ["update-ref", "-d", ref], { cwd });
    }
  } catch { /* no refs to clean — fine */ }
}
