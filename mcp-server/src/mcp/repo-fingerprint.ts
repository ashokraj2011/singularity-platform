/**
 * M61 Wire E — Repo fingerprint (mcp-server side).
 *
 * Direct port of agent-runtime's capabilities/repo-fingerprint.ts. The
 * two implementations MUST stay in lockstep — the agent-runtime drift
 * detector compares hashes byte-for-byte, so any divergence here (a
 * different file in BUILD_SYSTEM_FILES, a different skip rule on a
 * top-level entry) silently breaks the contract.
 *
 * Why duplicate instead of share: mcp-server lives outside the
 * agent-and-tools pnpm workspace and the shared `@agentandtools/shared`
 * package doesn't yet include capability helpers. The duplication is
 * narrow enough (single function, no deps beyond node:crypto and
 * node:fs) that the maintenance cost is lower than the build-system
 * cost of cross-package imports.
 *
 * If you change either file, update both:
 *   agent-and-tools/apps/agent-runtime/src/modules/capabilities/repo-fingerprint.ts
 *   mcp-server/src/mcp/repo-fingerprint.ts
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const BUILD_SYSTEM_FILES: readonly string[] = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "CMakeLists.txt",
  "Makefile",
  "WORKSPACE",
  "WORKSPACE.bazel",
  "MODULE.bazel",
  "Directory.Build.props",
  "Dockerfile",
  ".dockerignore",
] as const;

const PER_FILE_READ_CAP = 256 * 1024;

export type RepoFingerprintResult = {
  fingerprint: string;
  topLevelEntries: string[];
  hashedBuildFiles: string[];
  durationMs: number;
};

export function computeRepoFingerprint(workspacePath: string): RepoFingerprintResult {
  const started = Date.now();
  const hash = createHash("sha256");

  const entries: string[] = [];
  try {
    const raw = fs.readdirSync(workspacePath, { withFileTypes: true });
    for (const dirent of raw) {
      if (dirent.name === ".git") continue;
      if (dirent.name === "node_modules") continue;
      if (dirent.name === "dist") continue;
      if (dirent.name === "target") continue;
      if (dirent.name === ".gradle") continue;
      if (dirent.name === ".venv" || dirent.name === "venv") continue;
      const tag = dirent.isDirectory() ? "D" : dirent.isFile() ? "F" : "O";
      entries.push(`${tag}:${dirent.name}`);
    }
  } catch {
    return {
      fingerprint: "",
      topLevelEntries: [],
      hashedBuildFiles: [],
      durationMs: Date.now() - started,
    };
  }
  entries.sort();
  hash.update("TOP\n");
  for (const e of entries) hash.update(`${e}\n`);

  const hashedBuildFiles: string[] = [];
  hash.update("BUILD\n");
  for (const name of BUILD_SYSTEM_FILES) {
    const p = path.join(workspacePath, name);
    let body: string;
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      body = fs.readFileSync(p, "utf8");
      if (body.length > PER_FILE_READ_CAP) body = body.slice(0, PER_FILE_READ_CAP);
      hashedBuildFiles.push(name);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "READ_ERR";
      if (code === "ENOENT") continue;
      body = `<err: ${code}>`;
      hashedBuildFiles.push(`${name} (${code})`);
    }
    hash.update(`${name}\n${body}\n`);
  }

  return {
    fingerprint: `sha256:${hash.digest("hex")}`,
    topLevelEntries: entries,
    hashedBuildFiles,
    durationMs: Date.now() - started,
  };
}

/**
 * M61 Wire B P2 — Best-effort POST that an AST index was built for
 * the capability's workspace. Fire-and-forget; the call exists so
 * agent-runtime can stamp astIndexedAt + astIndexFiles on the
 * CapabilityWorldModel row.
 */
export async function reportAstIndexBuiltToAgentRuntime(
  agentRuntimeUrl: string,
  capabilityId: string,
  astIndexFiles: number,
): Promise<boolean> {
  if (!agentRuntimeUrl || !capabilityId) return false;
  const url = `${agentRuntimeUrl.replace(/\/+$/, "")}/capabilities/${encodeURIComponent(capabilityId)}/world-model/ast-index-built`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ astIndexFiles }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[ast-index-built] report failed for capability ${capabilityId}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Best-effort POST the fingerprint to agent-runtime's drift detector.
 * Resolves with the drift result on success, or null on any failure
 * (network error, non-2xx, missing config). The caller should fire-and-
 * forget this — a fingerprint report must never block the workflow.
 *
 * Logs a structured warn line on drift so the audit trail is
 * greppable from mcp-server container logs alongside the
 * agent-runtime warn line written by world-model-drift.service.
 */
export async function reportFingerprintToAgentRuntime(
  agentRuntimeUrl: string,
  capabilityId: string,
  result: RepoFingerprintResult,
): Promise<{ drift: boolean; firstStamp: boolean; previousFingerprint: string | null } | null> {
  if (!agentRuntimeUrl || !capabilityId || !result.fingerprint) return null;
  const url = `${agentRuntimeUrl.replace(/\/+$/, "")}/capabilities/${encodeURIComponent(capabilityId)}/world-model/fingerprint`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fingerprint: result.fingerprint,
        hashedBuildFiles: result.hashedBuildFiles,
        topLevelEntries: result.topLevelEntries,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[repo-fingerprint] HTTP ${res.status} from agent-runtime drift endpoint`);
      return null;
    }
    const body = await res.json() as { data?: { drift?: boolean; firstStamp?: boolean; previousFingerprint?: string | null } };
    const payload = body.data ?? (body as Record<string, unknown>);
    const out = {
      drift: Boolean((payload as { drift?: boolean }).drift),
      firstStamp: Boolean((payload as { firstStamp?: boolean }).firstStamp),
      previousFingerprint: (payload as { previousFingerprint?: string | null }).previousFingerprint ?? null,
    };
    if (out.drift) {
      // eslint-disable-next-line no-console
      console.warn(
        `[repo-fingerprint] drift capabilityId=${capabilityId} ` +
        `previous=${out.previousFingerprint} current=${result.fingerprint} ` +
        `hashedBuildFiles=${result.hashedBuildFiles.join(",")}`,
      );
    }
    return out;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[repo-fingerprint] report failed for capability ${capabilityId}: ${(err as Error).message}`);
    return null;
  }
}
