/**
 * Unit tests for M43 agentic workflow tools:
 *   - repo_map
 *   - recommended_verification
 *   - review_diff
 *
 * We use real git repos in tmp dirs to exercise the `git` subprocess paths.
 * repo_map and recommended_verification can also be tested without a git
 * history (they probe filesystem + verifier-registry directly).
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withSandboxRoot } from "../src/workspace/sandbox";
import { repoMapTool, recommendedVerificationTool, reviewDiffTool } from "../src/tools/workflow-tools";
import { clearVerifierCache } from "../src/workspace/verifier-registry";

async function withTempSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "mcp-workflow-"));
  try {
    return await withSandboxRoot(root, () => fn(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
}

describe("M43 repo_map", () => {
  it("detects Node topology when package.json is present", async () => {
    clearVerifierCache();
    await withTempSandbox(async (root) => {
      writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "x", scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit" },
      }));
      writeFileSync(join(root, "tsconfig.json"), "{}");
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "index.ts"), "export const x = 1;");

      const res = await repoMapTool.execute({});
      expect(res.success).toBe(true);
      const out = res.output as {
        topology: { rootKind: string; buildFiles: string[]; entrypoints: string[] };
        verifiers: Array<{ name: string; command: string }>;
      };
      expect(out.topology.rootKind).toBe("node");
      expect(out.topology.buildFiles).toContain("package.json");
      expect(out.topology.entrypoints).toContain("src/index.ts");
      expect(out.verifiers.map((v) => v.name)).toEqual(
        expect.arrayContaining(["test", "lint", "typecheck"]),
      );
    });
  });

  it("flags an unindexed empty repo with a clear note", async () => {
    clearVerifierCache();
    await withTempSandbox(async (root) => {
      void root;
      const res = await repoMapTool.execute({});
      const out = res.output as { topology: { rootKind: string }; notes: string[] };
      expect(out.topology.rootKind).toBe("unknown");
      expect(out.notes.join("\n")).toMatch(/no canonical build file/);
    });
  });

  it("marks rootKind=mixed when both pom.xml and package.json are present", async () => {
    clearVerifierCache();
    await withTempSandbox(async (root) => {
      writeFileSync(join(root, "pom.xml"), "<project/>");
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
      const res = await repoMapTool.execute({});
      const out = res.output as { topology: { rootKind: string }; notes: string[] };
      expect(out.topology.rootKind).toBe("mixed");
      expect(out.notes.join("\n")).toMatch(/monorepo/);
    });
  });
});

describe("M43 recommended_verification", () => {
  it("returns ranked, allowlist-checked verifiers", async () => {
    clearVerifierCache();
    await withTempSandbox(async (root) => {
      writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "x",
        scripts: { test: "vitest", typecheck: "tsc --noEmit", lint: "eslint ." },
      }));

      const res = await recommendedVerificationTool.execute({ changed_paths: ["src/foo.ts"] });
      expect(res.success).toBe(true);
      const out = res.output as {
        recommended: Array<{ name: string; runnable: boolean; rank: number; kind: string; rationale: string }>;
        none_available: boolean;
      };
      expect(out.none_available).toBe(false);
      // lint has the lowest KIND_RANK (1); should come first
      expect(out.recommended[0].kind).toBe("lint");
      // All three npm scripts are runnable (npm is in ALLOWED_COMMANDS)
      expect(out.recommended.every((r) => r.runnable)).toBe(true);
      // Touched-path rationale should mention the changed file
      expect(out.recommended[0].rationale).toMatch(/src\/foo\.ts/);
    });
  });

  it("returns none_available when no verifiers are detected", async () => {
    clearVerifierCache();
    await withTempSandbox(async (root) => {
      void root;
      const res = await recommendedVerificationTool.execute({});
      const out = res.output as { none_available: boolean; guidance: string };
      expect(out.none_available).toBe(true);
      expect(out.guidance).toMatch(/verification_unavailable/);
    });
  });
});

describe("M43 review_diff", () => {
  it("summarises a code+test edit with zero risks when matched", async () => {
    await withTempSandbox(async (root) => {
      gitInit(root);
      writeFileSync(join(root, "src.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "src.test.ts"), "import { a } from './src';\nexport const t = a;\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });
      // Modify both files so they show up in the working diff
      writeFileSync(join(root, "src.ts"), "export const a = 2;\n");
      writeFileSync(join(root, "src.test.ts"), "import { a } from './src';\nexport const t = a + 1;\n");

      const res = await reviewDiffTool.execute({
        verificationReceipts: [{ passed: true, command: "vitest", exit_code: 0 }],
        codeChangePaths: ["src.ts"],
      });
      const out = res.output as {
        changedFiles: Array<{ path: string; classification: string }>;
        classification: { codeChanged: boolean; testsChanged: boolean };
        risks: string[];
        readyToFinish: boolean;
      };
      expect(out.classification.codeChanged).toBe(true);
      expect(out.classification.testsChanged).toBe(true);
      const codeFile = out.changedFiles.find((f) => f.path === "src.ts");
      expect(codeFile?.classification).toBe("code");
      // Receipts passed + matched test => zero risks
      expect(out.risks).toEqual([]);
      expect(out.readyToFinish).toBe(true);
    });
  });

  it("flags risks when code changes lack tests and verification", async () => {
    await withTempSandbox(async (root) => {
      gitInit(root);
      writeFileSync(join(root, "service.java"), "class A {}\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });
      writeFileSync(join(root, "service.java"), "class A { public int x() { return 0; } }\n");

      const res = await reviewDiffTool.execute({});  // no receipts injected
      const out = res.output as {
        risks: string[];
        readyToFinish: boolean;
        testCoverage: { codeFilesWithoutMatchingTests: string[] };
      };
      expect(out.readyToFinish).toBe(false);
      // Expect at least the "no verification receipts" risk
      expect(out.risks.join(" | ")).toMatch(/no verification receipts/);
      // And the no-matching-test risk
      expect(out.testCoverage.codeFilesWithoutMatchingTests).toContain("service.java");
    });
  });

  it("reports failed verification as a risk", async () => {
    await withTempSandbox(async (root) => {
      gitInit(root);
      writeFileSync(join(root, "main.ts"), "export const x = 1;\n");
      writeFileSync(join(root, "main.test.ts"), "import { x } from './main';\nconsole.log(x);\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
      writeFileSync(join(root, "main.ts"), "export const x = 2;\n");

      const res = await reviewDiffTool.execute({
        verificationReceipts: [{ passed: false, command: "vitest", exit_code: 1 }],
      });
      const out = res.output as { risks: string[]; readyToFinish: boolean };
      expect(out.readyToFinish).toBe(false);
      expect(out.risks.join(" | ")).toMatch(/none passed/);
    });
  });
});
