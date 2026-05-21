/**
 * M52 Slice A — Code Context Budgeter pure-function tests.
 *
 * Two layers:
 *   - Pure helpers (deriveTargetQueries, expectedTestPathFor, estimateTokens):
 *     no setup, just behaviour assertions.
 *   - buildCodeContextPackage end-to-end: writes real Java/TS files into a
 *     temp sandbox, runs index_workspace, asserts the package shape.
 *
 * The end-to-end portion is the same pattern used by ast-index-driven tests
 * elsewhere — slow (~1-2s for the index walk) but exercises the real
 * algorithm, not mocks.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withSandboxRoot } from "../src/workspace/sandbox";
import {
  buildCodeContextPackage,
  deriveTargetQueries,
  expectedTestPathFor,
  estimateTokens,
} from "../src/mcp/code-context";

async function withTempSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "mcp-code-ctx-"));
  try {
    return await withSandboxRoot(root, () => fn(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("M52 estimateTokens", () => {
  it("uses the 4-chars-per-token rule of thumb", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});

describe("M52 deriveTargetQueries", () => {
  it("drops stopwords and short words, dedupes, caps at 6", () => {
    const out = deriveTargetQueries("Add containsACharacter operator to the rule engine");
    expect(out).toContain("containsacharacter");
    expect(out).toContain("rule");
    expect(out).toContain("engine");
    expect(out).not.toContain("the");
    expect(out).not.toContain("add");
    expect(out).not.toContain("operator"); // stopword in our list
    expect(out.length).toBeLessThanOrEqual(6);
  });

  it("returns empty array for an all-stopwords task", () => {
    expect(deriveTargetQueries("add the case for")).toEqual([]);
  });
});

describe("M52 expectedTestPathFor", () => {
  it("maps Java main → test convention", () => {
    const got = expectedTestPathFor("src/main/java/org/example/Foo.java");
    expect(got).toContain("src/test/java/org/example/FooTest.java");
    expect(got).toContain("src/test/java/org/example/FooIT.java");
  });
  it("maps TS to .test.ts / .spec.ts / __tests__", () => {
    const got = expectedTestPathFor("src/foo.ts");
    expect(got).toContain("src/foo.test.ts");
    expect(got).toContain("src/foo.spec.ts");
    expect(got).toContain("src/__tests__/foo.test.ts");
  });
  it("maps Python to test_<name>.py", () => {
    const got = expectedTestPathFor("app/handlers/users.py");
    expect(got).toContain("app/handlers/test_users.py");
    expect(got).toContain("tests/test_users.py");
  });
  it("maps Go to <name>_test.go", () => {
    const got = expectedTestPathFor("internal/service/auth.go");
    expect(got).toContain("internal/service/auth_test.go");
  });
});

describe("M52 buildCodeContextPackage (end-to-end with real AST index)", () => {
  it("returns a package shape with hashes + token accounting for a single-symbol task", async () => {
    await withTempSandbox(async (root) => {
      // One TS file with one exported symbol — small enough to be fast.
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "validator.ts"),
        "export function validateEmail(input: string): boolean {\n  return /@/.test(input);\n}\n",
      );

      const pkg = await buildCodeContextPackage({
        task_text: "Add a more thorough validateEmail check",
        target_hints: ["validateEmail"],
        max_token_budget: 1000,
        include_tests: false,
      });

      expect(pkg.context_package_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(pkg.task_intent.kind).toBe("code_modification");
      expect(pkg.target_symbols.length).toBeGreaterThanOrEqual(1);
      expect(pkg.target_symbols[0].symbol).toBe("validateEmail");
      expect(pkg.editable_slices.length).toBeGreaterThanOrEqual(1);
      const slice = pkg.editable_slices[0];
      expect(slice.file).toBe("src/validator.ts");
      expect(slice.content).toContain("validateEmail");
      expect(slice.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(slice.token_count).toBeGreaterThan(0);
      expect(pkg.optimization.optimized_estimate).toBe(slice.token_count);
    });
  });

  it("excludes a bogus target hint with a clear reason", async () => {
    await withTempSandbox(async (root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");

      const pkg = await buildCodeContextPackage({
        task_text: "implement bogusSymbol",
        target_hints: ["definitelyDoesNotExist_xy123"],
        max_token_budget: 1000,
      });
      expect(pkg.editable_slices.length).toBe(0);
      const exclusion = pkg.excluded_context.find((e) => e.symbol === "definitelyDoesNotExist_xy123");
      expect(exclusion).toBeDefined();
      expect(exclusion!.reason).toMatch(/not found in index/);
    });
  });

  it("classifies a read-style task as code_read intent", async () => {
    await withTempSandbox(async (root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
      const pkg = await buildCodeContextPackage({
        task_text: "Explain how validateEmail works",
        target_hints: ["validateEmail"],
        max_token_budget: 1000,
      });
      expect(pkg.task_intent.kind).toBe("code_read");
    });
  });

  it("respects max_token_budget by excluding over-budget slices", async () => {
    await withTempSandbox(async (root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      // Two functions; each one's slice is ~80 tokens.
      writeFileSync(
        join(root, "src", "a.ts"),
        "export function alpha() {\n" + "  return 'a';\n".repeat(20) + "}\n",
      );
      writeFileSync(
        join(root, "src", "b.ts"),
        "export function beta() {\n" + "  return 'b';\n".repeat(20) + "}\n",
      );

      const pkg = await buildCodeContextPackage({
        task_text: "modify alpha and beta",
        target_hints: ["alpha", "beta"],
        max_token_budget: 30, // very small — should not fit both
      });
      // At most one slice should fit
      expect(pkg.editable_slices.length + pkg.dependency_slices.length + pkg.test_slices.length).toBeLessThanOrEqual(1);
      // The over-budget one should be in excluded_context with an explanatory reason
      const overBudget = pkg.excluded_context.find((e) => /over token budget/.test(e.reason));
      expect(overBudget).toBeDefined();
    });
  });
});
