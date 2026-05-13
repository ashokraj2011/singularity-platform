import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { config } from "../config";
import { events } from "../events/bus";
import type { CorrelationIds } from "../audit/store";
import { sandboxRoot } from "./sandbox";

const execFileP = promisify(execFile);

export interface BranchRequest {
  workflowInstanceId?: string;
  nodeId?: string;
  workItemId?: string;
  branchBase?: string;
  branchName?: string;
}

export interface WorkBranchInfo {
  branch: string;
  baseBranch?: string;
  headSha?: string;
  reused: boolean;
}

export interface FinishBranchResult {
  branch: string;
  commitSha?: string;
  changedPaths: string[];
  patch?: string;
  committed: boolean;
  message: string;
  /** M27.5 — set only when caller asked for `push: true`. */
  pushed?: boolean;
  /** M27.5 — non-empty when the push attempt failed but the local commit succeeded. */
  pushError?: string;
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
  if (!req.workflowInstanceId || !req.nodeId || !req.workItemId) return null;
  const prefix = safePart(config.MCP_WORK_BRANCH_PREFIX, "sg");
  return [
    prefix,
    safePart(req.workflowInstanceId, "workflow").slice(0, 36),
    safePart(req.nodeId, "node").slice(0, 36),
    safePart(req.workItemId, "work").slice(0, 36),
  ].join("/").slice(0, 180);
}

async function git(args: string[], opts?: { allowFail?: boolean; maxBuffer?: number }): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd: sandboxRoot(),
      maxBuffer: opts?.maxBuffer ?? 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    if (opts?.allowFail) return "";
    throw err;
  }
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
    reused: exists,
  };
  events.publish({
    kind: "workspace.branch.created",
    correlation: correlation ?? { mcpInvocationId: "workspace" },
    payload: {
      branch,
      baseBranch: activeBranch.baseBranch,
      headSha: activeBranch.headSha,
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
    return {
      branch,
      changedPaths: [],
      committed: false,
      message: "no changes to commit",
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

  // M27.5 — optional upstream push. Off by default; opt-in per tool call.
  // We don't gate on `requires_approval` here because finish_work_branch
  // itself is the gate at the agent-loop level (and the new `push` arg is
  // explicitly opt-in by the caller).
  let pushed = false;
  let pushError: string | undefined;
  if (options?.push && commitSha) {
    const remote = options.remote?.trim() || "origin";
    try {
      const hasRemote = Boolean(await git(["remote", "get-url", remote], { allowFail: true }));
      if (!hasRemote) {
        pushError = `remote '${remote}' is not configured`;
      } else {
        await git(["push", "-u", remote, branch], { maxBuffer: 10 * 1024 * 1024 });
        pushed = true;
      }
    } catch (err) {
      pushError = (err as Error).message;
    }
  }

  return {
    branch,
    commitSha,
    changedPaths,
    patch: committedPatch || patch,
    committed: true,
    message: commitMessage,
    pushed: options?.push ? pushed : undefined,
    pushError,
  } as FinishBranchResult;
}
