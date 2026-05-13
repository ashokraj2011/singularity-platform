import * as path from "node:path";
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

export function sandboxRoot(): string {
  return path.resolve(config.MCP_SANDBOX_ROOT);
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
