/**
 * M72 Slice D — test-report-parser tests.
 *
 * Covers JUnit XML (Maven Surefire + Gradle test) and pytest --json-report
 * adapters. Each test writes a fixture report file into a temp directory
 * and asserts the parser returns the expected ParsedTestResults shape.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findAndParseStructuredReport } from "../src/tools/test-report-parser";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "m72d-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── helpers ────────────────────────────────────────────────────────────────

async function writeFile(relPath: string, content: string): Promise<void> {
  const full = path.join(tmpDir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

// ── Maven Surefire ─────────────────────────────────────────────────────────

describe("findAndParseStructuredReport — Maven Surefire", () => {
  it("parses passing + failing testcases from JUnit XML", async () => {
    await writeFile(
      "target/surefire-reports/TEST-com.example.OperatorTest.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.OperatorTest" tests="3" errors="0" failures="1" skipped="0">
  <testcase classname="com.example.OperatorTest" name="testValid" time="0.012"/>
  <testcase classname="com.example.OperatorTest" name="testEmpty" time="0.008"/>
  <testcase classname="com.example.OperatorTest" name="testNull" time="0.005">
    <failure type="java.lang.NullPointerException">stack trace here</failure>
  </testcase>
</testsuite>`
    );
    const result = await findAndParseStructuredReport(tmpDir, "mvn test");
    expect(result).not.toBeNull();
    expect(result!.format).toBe("maven");
    expect(result!.totalTests).toBe(3);
    expect(result!.passingTests).toEqual([
      "com.example.OperatorTest.testValid",
      "com.example.OperatorTest.testEmpty",
    ]);
    expect(result!.failingTests).toEqual(["com.example.OperatorTest.testNull"]);
    expect(result!.errorSummary).toContain("1 failure");
  });

  it("treats <error> child as failing alongside <failure>", async () => {
    await writeFile(
      "target/surefire-reports/TEST-com.example.SegmentTest.xml",
      `<testsuite name="com.example.SegmentTest" tests="2" errors="1" failures="0">
  <testcase classname="com.example.SegmentTest" name="testOk"/>
  <testcase classname="com.example.SegmentTest" name="testBlowsUp">
    <error type="RuntimeException">boom</error>
  </testcase>
</testsuite>`
    );
    const result = await findAndParseStructuredReport(tmpDir, "mvn -pl segment test");
    expect(result).not.toBeNull();
    expect(result!.failingTests).toEqual(["com.example.SegmentTest.testBlowsUp"]);
    expect(result!.passingTests).toEqual(["com.example.SegmentTest.testOk"]);
    expect(result!.errorSummary).toContain("1 error");
  });

  it("excludes <skipped> tests from both buckets", async () => {
    await writeFile(
      "target/surefire-reports/TEST-com.example.SkipTest.xml",
      `<testsuite tests="2" skipped="1">
  <testcase classname="com.example.SkipTest" name="testRuns"/>
  <testcase classname="com.example.SkipTest" name="testSkip"><skipped/></testcase>
</testsuite>`
    );
    const result = await findAndParseStructuredReport(tmpDir, "mvn test");
    expect(result!.passingTests).toEqual(["com.example.SkipTest.testRuns"]);
    expect(result!.failingTests).toEqual([]);
    // totalTests comes from the suite header — counts the skipped test
    expect(result!.totalTests).toBe(2);
  });

  it("aggregates across multiple Surefire XML files", async () => {
    await writeFile(
      "target/surefire-reports/TEST-com.example.OneTest.xml",
      `<testsuite tests="1">
  <testcase classname="com.example.OneTest" name="testA"/>
</testsuite>`
    );
    await writeFile(
      "target/surefire-reports/TEST-com.example.TwoTest.xml",
      `<testsuite tests="1" failures="1">
  <testcase classname="com.example.TwoTest" name="testB">
    <failure>nope</failure>
  </testcase>
</testsuite>`
    );
    const result = await findAndParseStructuredReport(tmpDir, "mvn test");
    expect(result!.passingTests).toContain("com.example.OneTest.testA");
    expect(result!.failingTests).toContain("com.example.TwoTest.testB");
    expect(result!.totalTests).toBe(2);
  });

  it("returns null when no Surefire reports exist", async () => {
    // Empty workspace.
    const result = await findAndParseStructuredReport(tmpDir, "mvn test");
    expect(result).toBeNull();
  });
});

// ── Gradle JUnit ───────────────────────────────────────────────────────────

describe("findAndParseStructuredReport — Gradle JUnit", () => {
  it("parses build/test-results/test/*.xml when command starts with ./gradlew", async () => {
    await writeFile(
      "build/test-results/test/TEST-com.example.GradleTest.xml",
      `<testsuite name="com.example.GradleTest" tests="2" failures="1">
  <testcase classname="com.example.GradleTest" name="testPass"/>
  <testcase classname="com.example.GradleTest" name="testFail">
    <failure>x</failure>
  </testcase>
</testsuite>`
    );
    const result = await findAndParseStructuredReport(tmpDir, "./gradlew test");
    expect(result).not.toBeNull();
    expect(result!.format).toBe("gradle-junit");
    expect(result!.passingTests).toEqual(["com.example.GradleTest.testPass"]);
    expect(result!.failingTests).toEqual(["com.example.GradleTest.testFail"]);
  });
});

// ── pytest --json-report ───────────────────────────────────────────────────

describe("findAndParseStructuredReport — pytest", () => {
  it("parses .report.json from pytest-json-report plugin", async () => {
    await writeFile(
      ".report.json",
      JSON.stringify({
        summary: { total: 3, passed: 2, failed: 1 },
        tests: [
          { nodeid: "tests/test_segment.py::test_ok", outcome: "passed" },
          { nodeid: "tests/test_segment.py::test_also_ok", outcome: "passed" },
          { nodeid: "tests/test_segment.py::test_npe", outcome: "failed" },
        ],
      })
    );
    const result = await findAndParseStructuredReport(tmpDir, "pytest tests/");
    expect(result).not.toBeNull();
    expect(result!.format).toBe("pytest-json");
    expect(result!.totalTests).toBe(3);
    expect(result!.passingTests).toHaveLength(2);
    expect(result!.failingTests).toEqual(["tests/test_segment.py::test_npe"]);
  });

  it("treats outcome=error like outcome=failed", async () => {
    await writeFile(
      ".report.json",
      JSON.stringify({
        summary: { total: 2, passed: 1, failed: 0, error: 1 },
        tests: [
          { nodeid: "tests/ok.py::test_a", outcome: "passed" },
          { nodeid: "tests/err.py::test_b", outcome: "error" },
        ],
      })
    );
    const result = await findAndParseStructuredReport(tmpDir, "pytest");
    expect(result!.failingTests).toEqual(["tests/err.py::test_b"]);
    expect(result!.errorSummary).toContain("1 error");
  });

  it("skips outcome=skipped without counting it as passing or failing", async () => {
    await writeFile(
      ".report.json",
      JSON.stringify({
        summary: { total: 2, passed: 1, skipped: 1 },
        tests: [
          { nodeid: "tests/ok.py::test_a", outcome: "passed" },
          { nodeid: "tests/skip.py::test_b", outcome: "skipped" },
        ],
      })
    );
    const result = await findAndParseStructuredReport(tmpDir, "pytest");
    expect(result!.passingTests).toEqual(["tests/ok.py::test_a"]);
    expect(result!.failingTests).toEqual([]);
  });

  it("returns null when no report file is present (plugin not installed)", async () => {
    const result = await findAndParseStructuredReport(tmpDir, "pytest");
    expect(result).toBeNull();
  });

  it("returns null when report file is malformed JSON", async () => {
    await writeFile(".report.json", "{not valid json");
    const result = await findAndParseStructuredReport(tmpDir, "pytest");
    expect(result).toBeNull();
  });
});

// ── command-mismatch handling ─────────────────────────────────────────────

describe("findAndParseStructuredReport — command routing", () => {
  it("doesn't try JUnit XML when the command is pytest (even if XML exists)", async () => {
    await writeFile(
      "target/surefire-reports/TEST-com.example.X.xml",
      `<testsuite tests="1"><testcase classname="X" name="t"/></testsuite>`
    );
    // pytest command — should not consult Maven directories.
    const result = await findAndParseStructuredReport(tmpDir, "pytest");
    expect(result).toBeNull();
  });

  it("returns null for non-test commands", async () => {
    await writeFile(
      "target/surefire-reports/TEST-com.example.X.xml",
      `<testsuite tests="1"><testcase classname="X" name="t"/></testsuite>`
    );
    const result = await findAndParseStructuredReport(tmpDir, "ls -la");
    expect(result).toBeNull();
  });
});
