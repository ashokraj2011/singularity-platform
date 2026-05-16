import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { CorrelationIds } from "../audit/store";
import { config } from "../config";
import { events } from "../events/bus";
import { sandboxRoot, SKIP_DIRS } from "./sandbox";

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
  try {
    const { stdout } = await execFileP("git", args, {
      cwd: opts?.cwd ?? sandboxRoot(),
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
    if (fs.existsSync(path.join(localPath, ".git"))) {
      const existingRemote = normalizeRemote(await currentRemote());
      const expected = normalizeRemote(localPath);
      const dirty = await dirtyPaths();
      if (existingRemote && existingRemote !== expected && dirty.length > 0) {
        throw new Error(`MCP workspace has dirty changes for a different repo (${existingRemote}); refusing to replace it with ${expected}`);
      }
      if (existingRemote === expected) {
        await git(["fetch", "origin"], { allowFail: true });
        if (req.sourceRef?.trim()) await checkoutRef(req.sourceRef);
      } else {
        await cloneIntoWorkspace(localPath, req.sourceRef);
      }
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
      message: "local workspace source materialized",
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

  const expected = normalizeRemote(cloneUrl);
  const existingRemote = normalizeRemote(await currentRemote());
  const dirty = await dirtyPaths();
  if (existingRemote && existingRemote !== expected && dirty.length > 0) {
    throw new Error(`MCP workspace has dirty changes for a different repo (${existingRemote}); refusing to replace it with ${expected}`);
  }

  if (existingRemote === expected) {
    await git(["fetch", "--depth=1", "origin"], { allowFail: true });
    if (req.sourceRef?.trim()) {
      await checkoutRef(req.sourceRef);
    } else {
      await git(["checkout", "-B", "main", "FETCH_HEAD"], { allowFail: true });
    }
  } else {
    await cloneIntoWorkspace(cloneUrl, req.sourceRef);
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
    message: existingRemote === expected ? "workspace source refreshed" : "workspace source cloned",
  };
  events.publish({
    kind: "workspace.source.checked_out",
    correlation: correlation ?? { mcpInvocationId: "workspace" },
    payload: { ...status },
  });
  return status;
}
