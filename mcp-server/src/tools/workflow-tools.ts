/**
 * M43 — Agentic workflow tools.
 *
 * Three new first-class tools that close the gap between "MCP has primitives"
 * and "the coding agent reliably succeeds end-to-end":
 *
 *   • repo_map               — compact repo topology for grounding (PLAN_DRAFT)
 *   • recommended_verification — runner-aware verifier ranking (VERIFY entry)
 *   • review_diff            — diff summary + test/verification coverage (FINALIZE)
 *
 * All three are LOW risk, read-only, sandbox-anchored. They reuse existing
 * infra (verifier-registry, ast-index, fs-git's git helpers) — no new
 * verification system.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sandboxRoot } from "../workspace/sandbox";
import { listIndexedFiles, statsForIndex } from "../workspace/ast-index";
import { detectVerifiers, type DetectedVerifier } from "../workspace/verifier-registry";
import { ALLOWED_COMMANDS } from "./command";
import type { ToolHandler } from "./registry";

const execFileP = promisify(execFile);

// ── shared git helpers ────────────────────────────────────────────────────

/** Returns paths changed vs HEAD (added/modified/deleted), relative to root. */
async function gitChangedPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain"], {
      cwd, maxBuffer: 2 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        // porcelain v1: "XY <path>" or "XY <old> -> <new>"
        const rest = l.replace(/^..\s+/, "");
        const arrow = rest.indexOf(" -> ");
        return arrow >= 0 ? rest.slice(arrow + 4) : rest;
      });
  } catch {
    return [];
  }
}

/** numstat per file: { path, additions, deletions, status }. */
async function gitNumstat(cwd: string): Promise<Array<{
  path: string; additions: number; deletions: number; status: "added" | "modified" | "deleted";
}>> {
  try {
    const [{ stdout: numStdout }, { stdout: statusStdout }] = await Promise.all([
      execFileP("git", ["diff", "HEAD", "--numstat"], { cwd, maxBuffer: 10 * 1024 * 1024 }),
      execFileP("git", ["status", "--porcelain"], { cwd, maxBuffer: 2 * 1024 * 1024 }),
    ]);
    const statusByPath = new Map<string, "added" | "modified" | "deleted">();
    for (const line of statusStdout.split("\n")) {
      const trimmed = line.replace(/^..\s+/, "").trim();
      if (!trimmed) continue;
      const code = line.slice(0, 2);
      const p = trimmed.split(" -> ").pop() ?? trimmed;
      if (code.includes("D")) statusByPath.set(p, "deleted");
      else if (code.includes("A") || code.includes("?")) statusByPath.set(p, "added");
      else statusByPath.set(p, "modified");
    }
    const rows: Array<{ path: string; additions: number; deletions: number; status: "added" | "modified" | "deleted" }> = [];
    for (const line of numStdout.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [add, del, p] = parts;
      rows.push({
        path: p.trim(),
        additions: add === "-" ? 0 : Number(add),
        deletions: del === "-" ? 0 : Number(del),
        status: statusByPath.get(p.trim()) ?? "modified",
      });
    }
    return rows;
  } catch {
    return [];
  }
}

// ── classification heuristics ──────────────────────────────────────────────

const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|(?:\.test\.|\.spec\.|Test\.|Spec\.)/;
const DOC_EXT_RE = /\.(md|mdx|rst|adoc|txt)$/i;
const CONFIG_FILES_RE = /(?:^|\/)(?:package\.json|tsconfig.*\.json|pyproject\.toml|setup\.py|pom\.xml|build\.gradle|build\.gradle\.kts|Cargo\.toml|go\.mod|Dockerfile|\.env\..*|.*\.ya?ml|.*\.toml)$/i;
const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|scala|go|rs|rb|php|cs|cpp|cc|c|h|swift|m)$/i;

function classifyFile(p: string): "code" | "test" | "config" | "docs" | "unknown" {
  if (TEST_PATH_RE.test(p)) return "test";
  if (DOC_EXT_RE.test(p)) return "docs";
  if (CODE_EXT_RE.test(p)) return "code";
  if (CONFIG_FILES_RE.test(p)) return "config";
  return "unknown";
}

/** Heuristic: given a code file, what's the conventional test path? */
function expectedTestPathFor(codePath: string): string[] {
  const base = path.basename(codePath);
  const dir = path.dirname(codePath);
  const ext = path.extname(base);
  const stem = base.slice(0, -ext.length);
  const candidates = new Set<string>();
  // ts/js conventions
  if (/\.(ts|tsx|js|jsx)$/i.test(ext)) {
    candidates.add(`${dir}/${stem}.test${ext}`);
    candidates.add(`${dir}/${stem}.spec${ext}`);
    candidates.add(`${dir}/__tests__/${stem}.test${ext}`);
  }
  // Java
  if (ext === ".java") {
    const replacedMain = codePath.replace("/main/", "/test/");
    candidates.add(replacedMain.replace(`${stem}.java`, `${stem}Test.java`));
    candidates.add(replacedMain.replace(`${stem}.java`, `${stem}IT.java`));
  }
  // Python
  if (ext === ".py") {
    candidates.add(`${dir}/test_${base}`);
    candidates.add(`tests/test_${base}`);
  }
  // Go
  if (ext === ".go") {
    candidates.add(`${dir}/${stem}_test.go`);
  }
  return [...candidates];
}

// ── repo_map ───────────────────────────────────────────────────────────────

export const repoMapTool: ToolHandler = {
  descriptor: {
    name: "repo_map",
    description:
      "Compact architectural summary of the sandboxed repo. Combines lightweight " +
      "filesystem probing (build files, entrypoints, test dirs) with AST-index metadata " +
      "(language histogram, indexed file/symbol counts) and the detected verifier list. " +
      "Pin the output into context once at the start of PLAN_DRAFT — far cheaper than " +
      "exploring directory by directory, and language detection is tree-sitter-accurate.",
    natural_language:
      "Call this once at the start of work to get oriented in an unfamiliar repo. " +
      "Returns build system, dominant languages, entrypoint guesses, test locations, " +
      "and the verifier registry's recommendations — everything you need to plan the " +
      "first edits without random file reads.",
    input_schema: {
      type: "object",
      properties: {
        max_directories: {
          type: "number",
          description: "Cap on key-directory rows. Default 12, max 30.",
        },
      },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const root = sandboxRoot();
      const maxDirs = Math.min(Math.max(Number(args.max_directories ?? 12), 1), 30);

      // Build-system + entrypoint detection. Probe well-known files at root.
      const buildFiles: string[] = [];
      const probe = async (rel: string) => {
        if (fs.existsSync(path.join(root, rel))) buildFiles.push(rel);
      };
      await Promise.all([
        probe("package.json"), probe("pom.xml"), probe("build.gradle"),
        probe("build.gradle.kts"), probe("settings.gradle"), probe("settings.gradle.kts"),
        probe("pyproject.toml"), probe("setup.py"), probe("requirements.txt"),
        probe("go.mod"), probe("Cargo.toml"), probe("Gemfile"), probe("composer.json"),
        probe("Makefile"), probe("Dockerfile"), probe("tsconfig.json"),
      ]);

      // rootKind heuristic
      let rootKind = "unknown";
      if (buildFiles.includes("pom.xml")) rootKind = "java-maven";
      else if (buildFiles.some((f) => f.startsWith("build.gradle"))) rootKind = "java-gradle";
      else if (buildFiles.includes("package.json")) rootKind = "node";
      else if (buildFiles.includes("pyproject.toml") || buildFiles.includes("setup.py")) rootKind = "python";
      else if (buildFiles.includes("go.mod")) rootKind = "go";
      else if (buildFiles.includes("Cargo.toml")) rootKind = "rust";
      const hasMultiple = [
        buildFiles.includes("package.json"),
        buildFiles.includes("pom.xml"),
        buildFiles.includes("pyproject.toml"),
        buildFiles.includes("go.mod"),
      ].filter(Boolean).length >= 2;
      if (hasMultiple) rootKind = "mixed";

      // Pull stats + language histogram from the AST index
      const indexStats = await statsForIndex();
      const indexed = await listIndexedFiles({ limit: 1000 });
      const langMap = new Map<string, { count: number; bytes: number }>();
      for (const f of indexed) {
        const cur = langMap.get(f.language) ?? { count: 0, bytes: 0 };
        cur.count += 1;
        cur.bytes += f.size;
        langMap.set(f.language, cur);
      }
      const languages = [...langMap.entries()]
        .map(([language, v]) => ({ language, fileCount: v.count, bytes: v.bytes }))
        .sort((a, b) => b.fileCount - a.fileCount);

      // Key directories — group indexed files by top-level dir
      const dirCounts = new Map<string, { count: number; langs: Set<string> }>();
      for (const f of indexed) {
        const top = f.path.split("/")[0] ?? ".";
        const cur = dirCounts.get(top) ?? { count: 0, langs: new Set<string>() };
        cur.count += 1;
        cur.langs.add(f.language);
        dirCounts.set(top, cur);
      }
      const keyDirectories = [...dirCounts.entries()]
        .map(([p, v]) => ({ path: p, fileCount: v.count, languages: [...v.langs] }))
        .sort((a, b) => b.fileCount - a.fileCount)
        .slice(0, maxDirs);

      // Entrypoint guesses — well-known file patterns per stack
      const entryCandidates: string[] = [];
      const tryRel = (rel: string) => {
        if (fs.existsSync(path.join(root, rel))) entryCandidates.push(rel);
      };
      tryRel("src/index.ts"); tryRel("src/index.js"); tryRel("src/main.ts");
      tryRel("main.py"); tryRel("app.py"); tryRel("src/main.py");
      tryRel("cmd/main.go"); tryRel("main.go");
      tryRel("src/main/java"); // Java directory marker
      // Plus: any *Application.java in indexed files
      for (const f of indexed) {
        if (/Application\.(java|kt)$/.test(f.path) || /^src\/(?:index|main|app)\.(?:ts|tsx|js|jsx)$/.test(f.path)) {
          if (!entryCandidates.includes(f.path)) entryCandidates.push(f.path);
        }
      }

      // Test directories — top-level dirs whose files look testy
      const testDirs = new Set<string>();
      for (const f of indexed) {
        if (TEST_PATH_RE.test(f.path)) {
          const top = f.path.split("/").slice(0, 3).join("/");
          testDirs.add(top);
        }
      }

      // Verifier registry hand-off
      const verifiers = await detectVerifiers(root).catch(() => [] as DetectedVerifier[]);

      const notes: string[] = [];
      if (rootKind === "unknown") notes.push("no canonical build file detected at root — agent may need to scan deeper");
      if (rootKind === "mixed") notes.push("multiple build systems detected — monorepo, treat sub-projects separately");
      if (indexStats.indexedFiles === 0) notes.push("AST index is empty — call index_workspace first");
      if (verifiers.length === 0) notes.push("no verifiers detected — verification will require manual command or verification_unavailable");

      return {
        success: true,
        output: {
          topology: {
            rootKind,
            buildFiles,
            entrypoints: entryCandidates.slice(0, 6),
            testDirs: [...testDirs].sort(),
            keyDirectories,
          },
          languages,
          totals: {
            indexedFiles: indexStats.indexedFiles,
            indexedSymbols: indexStats.indexedSymbols,
          },
          verifiers: verifiers.map((v) => ({
            name: v.name, kind: v.kind, command: v.command, args: v.args, perFile: v.perFile,
          })),
          notes,
        },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

// ── recommended_verification ───────────────────────────────────────────────

/** Lower is better; run typecheck/lint before slower compile/test cycles. */
const KIND_RANK: Record<DetectedVerifier["kind"], number> = {
  lint: 1, typecheck: 2, compile: 3, test: 4,
};

export const recommendedVerificationTool: ToolHandler = {
  descriptor: {
    name: "recommended_verification",
    description:
      "Return the verifier-registry's recommended verification commands for the current " +
      "workspace, ranked by changed paths. Each row reports `runnable` against the MCP " +
      "command allowlist so the agent never picks a command that will be rejected. Use " +
      "this in VERIFY entry to pick the right `run_test` invocation deterministically — " +
      "do NOT free-form invent verification commands.",
    natural_language:
      "Use this at the start of VERIFY to find out what to run. The list is sorted with " +
      "the most-likely-to-catch-your-changes command first (typecheck/lint before slow " +
      "test suites). Pass the top runnable entry's command + args straight to run_test.",
    input_schema: {
      type: "object",
      properties: {
        changed_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. Paths recently modified. If omitted, the tool computes them from " +
            "`git status --porcelain` in the sandbox. Used to rank per-file verifiers.",
        },
      },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const root = sandboxRoot();
      const changedPaths = Array.isArray(args.changed_paths) && args.changed_paths.length > 0
        ? (args.changed_paths as unknown[]).filter((p): p is string => typeof p === "string")
        : await gitChangedPaths(root);

      const verifiers = await detectVerifiers(root);

      const recommended = verifiers
        .map((v) => {
          // Does any changed path match this verifier's filePatterns?
          const matchedPaths = changedPaths.filter((p) =>
            v.filePatterns.some((ext) => p.endsWith(ext)),
          );
          const touchScore = matchedPaths.length > 0 ? 0 : 10;
          const runnable = ALLOWED_COMMANDS.has(v.command);

          const rationaleParts: string[] = [];
          rationaleParts.push(`detected from ${v.detectedFrom}`);
          if (matchedPaths.length > 0) {
            rationaleParts.push(
              `covers ${matchedPaths.length} changed file(s)${matchedPaths.length <= 3 ? `: ${matchedPaths.join(", ")}` : ""}`,
            );
          } else if (changedPaths.length === 0) {
            rationaleParts.push("no changed paths supplied — generic ranking");
          } else {
            rationaleParts.push("changed paths don't match this verifier's filePatterns");
          }
          if (!runnable) rationaleParts.push(`'${v.command}' is NOT in the MCP allowlist — cannot run via run_test`);

          return {
            name: v.name,
            command: v.command,
            args: v.args,
            kind: v.kind,
            runnable,
            rank: KIND_RANK[v.kind] + touchScore,
            matchedPaths,
            rationale: rationaleParts.join("; "),
          };
        })
        .sort((a, b) => a.rank - b.rank);

      return {
        success: true,
        output: {
          changedPaths,
          recommended,
          none_available: recommended.length === 0,
          guidance: recommended.length === 0
            ? "No verifiers detected. Call verification_unavailable with reason='no verifier registry hits'."
            : `Run the first runnable entry via run_test. If none are runnable, call verification_unavailable.`,
        },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

// ── review_diff ────────────────────────────────────────────────────────────

export const reviewDiffTool: ToolHandler = {
  descriptor: {
    name: "review_diff",
    description:
      "Pre-finish diff review. Summarises every changed file (additions/deletions/" +
      "status), classifies kind (code/test/config/docs), checks whether code changes have " +
      "matching test files, and — when verification receipts are present in loop state — " +
      "reports which changed paths the receipts cover. Surface obvious risks (no tests " +
      "for new code, config changes without docs) BEFORE finish_work_branch.",
    natural_language:
      "Call this in FINALIZE (or just before) to sanity-check the work product. The " +
      "output's `risks` array is the punch list — address each item or be ready to " +
      "explain why it's acceptable in the final summary.",
    input_schema: {
      type: "object",
      properties: {
        // Both injected by the invoke loop, not by the LLM. Documented so the
        // schema stays honest, but the agent typically calls with no args.
        verificationReceipts: {
          type: "array",
          description:
            "INJECTED BY LOOP STATE — do not populate. Verification receipts collected " +
            "during VERIFY. The tool intersects each receipt's covered paths with the diff.",
        },
        codeChangePaths: {
          type: "array",
          description:
            "INJECTED BY LOOP STATE — do not populate. Paths that mutation tools touched.",
        },
      },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const root = sandboxRoot();
      const numstat = await gitNumstat(root);
      const receipts = Array.isArray(args.verificationReceipts) ? args.verificationReceipts as Array<Record<string, unknown>> : [];
      const codeChangePaths = Array.isArray(args.codeChangePaths) ? (args.codeChangePaths as unknown[]).filter((p): p is string => typeof p === "string") : [];

      // Resolve branch + commit context
      let branch = "(detached)";
      try {
        const { stdout } = await execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
        branch = stdout.trim();
      } catch { /* leave as detached */ }

      const changedFiles = numstat.map((row) => ({
        path: row.path,
        status: row.status,
        additions: row.additions,
        deletions: row.deletions,
        classification: classifyFile(row.path),
      }));

      const codeChanged = changedFiles.some((f) => f.classification === "code");
      const testsChanged = changedFiles.some((f) => f.classification === "test");
      const docsChanged = changedFiles.some((f) => f.classification === "docs");
      const configChanged = changedFiles.some((f) => f.classification === "config");

      // Test-coverage heuristic — for each code file that wasn't itself a test,
      // check whether ANY of its expected-test-path candidates is in the diff
      // OR already exists in the workspace.
      const codeFilesWithoutMatchingTests: string[] = [];
      const diffPaths = new Set(changedFiles.map((f) => f.path));
      for (const f of changedFiles) {
        if (f.classification !== "code") continue;
        if (f.status === "deleted") continue;
        const candidates = expectedTestPathFor(f.path);
        const matched = candidates.some((c) => diffPaths.has(c) || fs.existsSync(path.join(root, c)));
        if (!matched && candidates.length > 0) {
          codeFilesWithoutMatchingTests.push(f.path);
        }
      }

      // Verification coverage — receipt.changed_paths (when present) ∩ diff
      const coveredPaths = new Set<string>();
      let receiptsPassed = 0;
      for (const r of receipts) {
        const passed = r.passed === true || r.exit_code === 0 || r.exitCode === 0;
        if (passed) receiptsPassed += 1;
        const paths = Array.isArray(r.changed_paths)
          ? r.changed_paths as string[]
          : Array.isArray(r.paths_touched)
            ? r.paths_touched as string[]
            : [];
        for (const p of paths) if (typeof p === "string") coveredPaths.add(p);
      }
      // If we have receipts but no path-level info, treat the receipt as covering all code paths
      // (it ran against the whole workspace; not perfect but honest).
      const pathLevelInfoMissing = receipts.length > 0 && coveredPaths.size === 0;
      const codePathsInDiff = changedFiles.filter((f) => f.classification === "code").map((f) => f.path);
      const pathsCovered = pathLevelInfoMissing ? codePathsInDiff : codePathsInDiff.filter((p) => coveredPaths.has(p));
      const pathsMissing = pathLevelInfoMissing ? [] : codePathsInDiff.filter((p) => !coveredPaths.has(p));

      const risks: string[] = [];
      if (codeChanged && !testsChanged && codeFilesWithoutMatchingTests.length > 0) {
        risks.push(
          `code files changed without matching tests: ${codeFilesWithoutMatchingTests.slice(0, 5).join(", ")}` +
          (codeFilesWithoutMatchingTests.length > 5 ? ` (+${codeFilesWithoutMatchingTests.length - 5} more)` : ""),
        );
      }
      if (codeChanged && receipts.length === 0) {
        risks.push("code changes present but no verification receipts in loop state — run a verifier before finish");
      }
      if (codeChanged && receipts.length > 0 && receiptsPassed === 0) {
        risks.push("verification receipts present but none passed — do not finish");
      }
      if (codeChanged && pathsMissing.length > 0 && !pathLevelInfoMissing) {
        risks.push(`verification didn't cover: ${pathsMissing.slice(0, 5).join(", ")}`);
      }
      if (codeChangePaths.length > 0) {
        const trackedNotInDiff = codeChangePaths.filter((p) => !diffPaths.has(p));
        if (trackedNotInDiff.length > 0) {
          risks.push(`code-change tool reported paths the git diff doesn't show: ${trackedNotInDiff.slice(0, 3).join(", ")}`);
        }
      }
      if (configChanged && !docsChanged) {
        risks.push("config files changed but no docs touched — consider whether README/changelog needs updating");
      }

      const totalAdditions = numstat.reduce((s, r) => s + r.additions, 0);
      const totalDeletions = numstat.reduce((s, r) => s + r.deletions, 0);

      return {
        success: true,
        output: {
          branch,
          changedFiles,
          classification: { codeChanged, testsChanged, docsChanged, configChanged },
          testCoverage: {
            codeFilesWithoutMatchingTests,
            note: codeFilesWithoutMatchingTests.length === 0 && codeChanged
              ? "every changed code file has a matching test path (existing or in diff)"
              : undefined,
          },
          verificationCoverage: {
            receipts: receipts.length,
            receiptsPassed,
            pathsCovered,
            pathsMissing,
            note: pathLevelInfoMissing
              ? "receipts present but path-level coverage unknown; assumed whole-workspace"
              : undefined,
          },
          patchSummary: { totalAdditions, totalDeletions },
          risks,
          readyToFinish: risks.length === 0,
        },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};
