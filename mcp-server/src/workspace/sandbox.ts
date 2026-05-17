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

export function workspaceRootForRunContext(req: WorkspaceRootRequest): string {
  const identity = req.workItemCode?.trim()
    || (req.branchName?.trim() ? safeWorkspaceSegment(req.branchName, "") : "")
    || req.workItemId?.trim();
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
