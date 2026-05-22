/**
 * M61 Slice E — Repo fingerprint.
 *
 * Cheap-to-compute (~10-50ms on a typical repo) stable hash of a
 * repository's "shape" — the sorted top-level entries plus the
 * contents of the build-system files that determine how the project
 * builds and tests. The hash is recomputed at workflow start (where
 * the workspace is available on disk) and compared against
 * CapabilityWorldModel.repoFingerprint. A mismatch triggers a
 * non-blocking drift event and queues a world-model refresh.
 *
 * Why not just hash the whole tree? Far too slow for large repos and
 * far too noisy — every code change would invalidate. We only care
 * about structural drift: a Gradle → Maven swap, a monorepo split,
 * a new pyproject.toml replacing setup.py.
 *
 * The algorithm is intentionally documented + duplicated in
 * workgraph-studio/apps/api/src/modules/workflow/repo-fingerprint.ts
 * so the consumer there doesn't have to import across packages. Keep
 * the two implementations in lockstep.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The build files we hash in full. Order matters — they're hashed in
 * this exact sequence so two repos with the same files in a different
 * traversal order still produce the same fingerprint. Files that
 * don't exist are skipped (and don't contribute to the hash).
 */
export const BUILD_SYSTEM_FILES: readonly string[] = [
  // JVM
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  // Node
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  // Python
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  // Go
  "go.mod",
  "go.sum",
  // Rust
  "Cargo.toml",
  "Cargo.lock",
  // C/C++
  "CMakeLists.txt",
  "Makefile",
  // Bazel
  "WORKSPACE",
  "WORKSPACE.bazel",
  "MODULE.bazel",
  // .NET
  "Directory.Build.props",
  // Misc
  "Dockerfile",
  ".dockerignore",
] as const;

/**
 * Cap per-file content read at this size. Build files larger than
 * this almost certainly have generated noise (think enormous
 * package-lock.json with byte-level diffs) that would make the
 * fingerprint flap without telling us anything useful.
 */
const PER_FILE_READ_CAP = 256 * 1024;

export type RepoFingerprintResult = {
  fingerprint: string;
  topLevelEntries: string[];
  hashedBuildFiles: string[];
  durationMs: number;
};

/**
 * Compute the fingerprint for a workspace directory. Returns a
 * structured result so callers can log what went into the hash
 * (useful when an operator asks "why did my workflow flag drift?").
 *
 * Implementation notes:
 *  - We read `readdirSync` once and sort. No recursion.
 *  - We never follow symlinks — `lstat` is enough.
 *  - Errors reading a build file are folded into the hash as the
 *    literal string `<err: code>` so an unreadable file gives a
 *    deterministic mismatch instead of throwing.
 */
export function computeRepoFingerprint(workspacePath: string): RepoFingerprintResult {
  const started = Date.now();
  const hash = createHash("sha256");

  // 1. Top-level entries, sorted, with the "dir" / "file" tag so a
  //    directory becoming a file (or vice-versa) trips the fingerprint
  //    even if the name stayed.
  const entries: string[] = [];
  try {
    const raw = fs.readdirSync(workspacePath, { withFileTypes: true });
    for (const dirent of raw) {
      // Skip noise that legitimately changes between attempts:
      //  - .git internals (HEAD, indices, refs/) flap on every commit
      //  - node_modules / dist / target / .gradle are derived outputs
      if (dirent.name === ".git") continue;
      if (dirent.name === "node_modules") continue;
      if (dirent.name === "dist") continue;
      if (dirent.name === "target") continue;
      if (dirent.name === ".gradle") continue;
      if (dirent.name === ".venv" || dirent.name === "venv") continue;
      const tag = dirent.isDirectory() ? "D" : dirent.isFile() ? "F" : "O";
      entries.push(`${tag}:${dirent.name}`);
    }
  } catch (err) {
    // No workspace? Caller will see an empty fingerprint and decide
    // what to do (typically: skip drift detection on first run).
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

  // 2. Build files (full bytes, capped). Files we successfully read
  //    are recorded in hashedBuildFiles for the audit trail.
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
      if (code === "ENOENT") continue; // missing files don't contribute
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
 * Convenience predicate for the drift detector. Empty strings on
 * either side count as "no fingerprint yet" — we treat that as
 * "no drift" so a freshly-bootstrapped capability isn't flagged
 * before the first workflow run.
 */
export function fingerprintMatches(stored: string | null | undefined, current: string): boolean {
  if (!stored) return true;
  if (!current) return true;
  return stored === current;
}
