/**
 * M70.1 — Verify detectNoTestsRan catches the "test exited 0 but ran
 * zero tests" false-positive across the major test runners.
 *
 * Each test feeds a representative stdout/stderr blob from a real test
 * runner's no-match output and asserts the helper flags it. The tail
 * group ensures legitimate test output is NOT flagged.
 */
import { describe, expect, it } from "vitest";
import { detectNoTestsRan } from "../src/tools/command";

describe("M70.1 — detectNoTestsRan", () => {
  describe("flags 'no tests actually ran' as noTests:true", () => {
    it("Maven Surefire: filter matched no methods", () => {
      // This is the exact pattern from today's failing RuleEngine run.
      const stdout = `
[INFO] -------------------------------------------------------
[INFO]  T E S T S
[INFO] -------------------------------------------------------
[INFO] Running RuleEngineServiceTest
[INFO] Tests run: 0, Failures: 0, Errors: 0, Skipped: 0
[INFO] Results:
[INFO] Tests run: 0, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
`;
      const result = detectNoTestsRan(stdout, "");
      expect(result.noTests).toBe(true);
      if (result.noTests) expect(result.reason).toMatch(/maven\/junit/i);
    });

    it("Maven Surefire: 'No tests to run' message", () => {
      const result = detectNoTestsRan("[INFO] No tests to run.\n[INFO] BUILD SUCCESS", "");
      expect(result.noTests).toBe(true);
    });

    it("pytest: collected 0 items", () => {
      const result = detectNoTestsRan("============= collected 0 items =============", "");
      expect(result.noTests).toBe(true);
    });

    it("pytest: no tests ran in 0.01s", () => {
      const result = detectNoTestsRan("no tests ran in 0.01s", "");
      expect(result.noTests).toBe(true);
    });

    it("Python unittest: Ran 0 tests", () => {
      const result = detectNoTestsRan("Ran 0 tests in 0.000s\n\nOK", "");
      expect(result.noTests).toBe(true);
    });

    it("Jest: 0 total tests", () => {
      const result = detectNoTestsRan(
        "Tests:       0 total\nSnapshots:   0 total\nTime:        0.5 s",
        "",
      );
      expect(result.noTests).toBe(true);
    });

    it("Jest: no tests found", () => {
      const result = detectNoTestsRan("No tests found, exiting with code 1.", "");
      expect(result.noTests).toBe(true);
    });

    it("Go: no test files", () => {
      const result = detectNoTestsRan("?   github.com/user/pkg  [no test files]", "");
      expect(result.noTests).toBe(true);
    });

    it("Go: -run matched nothing", () => {
      const result = detectNoTestsRan("testing: warning: no tests to run\nPASS", "");
      expect(result.noTests).toBe(true);
    });

    it("Cargo: running 0 tests", () => {
      const result = detectNoTestsRan(
        "running 0 tests\n\ntest result: ok. 0 passed; 0 failed",
        "",
      );
      expect(result.noTests).toBe(true);
    });

    it("dotnet: Total tests: 0", () => {
      const result = detectNoTestsRan("Total tests: 0\nPassed: 0", "");
      expect(result.noTests).toBe(true);
    });

    it("RSpec: 0 examples", () => {
      const result = detectNoTestsRan("Finished in 0.001 seconds\n0 examples, 0 failures", "");
      expect(result.noTests).toBe(true);
    });
  });

  describe("does NOT flag legitimate test runs", () => {
    it("Maven with real test counts", () => {
      const stdout = `
[INFO] Tests run: 14, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
`;
      expect(detectNoTestsRan(stdout, "").noTests).toBe(false);
    });

    it("pytest with real test counts", () => {
      expect(detectNoTestsRan("collected 42 items\n42 passed in 1.23s", "").noTests).toBe(false);
    });

    it("Jest with real test counts", () => {
      expect(detectNoTestsRan("Tests:       3 passed, 3 total", "").noTests).toBe(false);
    });

    it("Mocha with passes and pending", () => {
      // "0 passing" alone is suspicious, but 0 passing + pending is a
      // legitimate "all tests are pending" state.
      expect(detectNoTestsRan("0 passing\n5 pending", "").noTests).toBe(false);
    });

    it("empty output is ambiguous (don't flag)", () => {
      expect(detectNoTestsRan("", "").noTests).toBe(false);
    });

    it("unrelated build output (lint, compile) is ambiguous", () => {
      expect(detectNoTestsRan("[INFO] Compiled 17 source files", "").noTests).toBe(false);
    });
  });
});
