import { execFile } from "node:child_process";
import * as fs from "node:fs";
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
  pushBlockedCode?: "GIT_AUTH_MISSING" | "GIT_REMOTE_UNREACHABLE" | "GIT_PUSH_REJECTED" | "NO_COMMIT_TO_PUSH";
  pushFixCommands?: string[];
  pushRetryable?: boolean;
  pushRemote?: string;
}

let activeBranch: WorkBranchInfo | null = null;

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

function fixCommandsForPushBlock(code: PushBlockedCode, remote: string): string[] {
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
  return [
    "Inspect the remote rejection, update/rebase the work branch if needed, then retry Git Push.",
    "./singularity.sh doctor git",
  ];
}

function classifyPushError(error: string): PushBlockedCode {
  const lower = error.toLowerCase();
  if (
    lower.includes("could not read username")
    || lower.includes("authentication failed")
    || lower.includes("permission denied")
    || lower.includes("could not read from remote repository")
    || lower.includes("repository not found")
  ) {
    return "GIT_AUTH_MISSING";
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
  return "GIT_PUSH_REJECTED";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function ensureAskPassScript(): Promise<string> {
  const dir = path.join(sandboxRoot(), ".git", "singularity");
  await fs.promises.mkdir(dir, { recursive: true });
  const script = path.join(dir, "git-askpass.sh");
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
  const excludePath = path.join(sandboxRoot(), ".git", "info", "exclude");
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
  const porcelain = await git(["status", "--porcelain"], { allowFail: true });
  return porcelain.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
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

  return {
    branch,
    commitSha,
    changedPaths,
    patch: committedPatch || patch,
    workspaceRoot: sandboxRoot(),
    committed: true,
    message: commitMessage,
    ...pushFields(push),
  } as FinishBranchResult;
}
