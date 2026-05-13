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

export async function finishWorkBranch(message?: string): Promise<FinishBranchResult> {
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
  return {
    branch,
    commitSha,
    changedPaths,
    patch: committedPatch || patch,
    committed: true,
    message: commitMessage,
  };
}
