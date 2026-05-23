/**
 * M72 Slice D — Structured test-report adapters.
 *
 * The stdout-regex parser in command.ts:parseTestRunnerOutput is fragile —
 * it depends on per-framework log formats that change across versions and
 * locales. A regex miss means pre-existing failures slip through as "new
 * regressions", which the M70.4 baseline machinery was supposed to prevent.
 *
 * This module replaces (or augments) the stdout heuristic with real
 * structured-report parsing:
 *
 *   - Maven Surefire / Failsafe → target/surefire-reports/*.xml,
 *                                  target/failsafe-reports/*.xml
 *   - Gradle JUnit               → build/test-results/test/*.xml,
 *                                  build/test-results/**\/*.xml
 *   - pytest                     → .report.json / .pytest-report.json
 *                                  (requires pytest-json-report plugin —
 *                                  the agent's verify command may or may
 *                                  not pass --json-report; we discover
 *                                  whichever it produced)
 *
 * Each adapter returns the SAME ParsedTestResults shape that the stdout
 * parser produces, so the M48 diff/baseline machinery doesn't change.
 *
 * Jest, go test -json, cargo test --format json, dotnet test --logger
 * trx, mocha mochawesome — out of scope for this slice; the stdout
 * fallback still applies. Adding them is a follow-up commit.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Mirrors command.ts:ParsedTestResults. Duplicated here to avoid a circular
 * import; command.ts re-exports our parser results as its own type.
 */
export interface ParsedTestResults {
  format: "maven" | "gradle-junit" | "pytest-json" | "unparseable";
  totalTests?: number;
  passingTests: string[];
  failingTests: string[];
  errorSummary?: string;
}

/**
 * Try every available structured-report adapter for the given command +
 * workspace. Returns the first hit; falls back to null when no structured
 * artifact exists (caller then uses stdout parsing).
 *
 * The order matters: JUnit XML is checked first because it's the most
 * common (Maven + Gradle + JUnit5 all write it), then pytest JSON. Once
 * we find a non-empty parse, we return it without consulting other paths
 * to avoid double-counting.
 */
export async function findAndParseStructuredReport(
  workspaceRoot: string,
  command: string,
): Promise<ParsedTestResults | null> {
  const cmd = command.toLowerCase();

  // Maven / Gradle / generic JUnit-XML emitters.
  if (cmd.includes("mvn") || cmd.includes("maven") || cmd.includes("gradle") || cmd.includes("./gradlew")) {
    const result = await parseJUnitXmlReports(workspaceRoot, cmd.includes("gradle") || cmd.includes("./gradlew") ? "gradle-junit" : "maven");
    if (result && (result.totalTests ?? 0) > 0) return result;
  }

  // pytest. Only kicks in when pytest-json-report wrote a file; we don't
  // inject the --json-report flag because that would require us to mutate
  // the agent's command.
  if (cmd.includes("pytest") || cmd.startsWith("py.test") || cmd.includes("python -m pytest")) {
    const result = await parsePytestJsonReport(workspaceRoot);
    if (result && (result.totalTests ?? 0) > 0) return result;
  }

  return null;
}

// ─── JUnit XML (Maven Surefire / Gradle test) ──────────────────────────────

const JUNIT_XML_SEARCH_DIRS = [
  "target/surefire-reports",
  "target/failsafe-reports",
  "build/test-results/test",
  "build/test-results/integrationTest",
] as const;

/**
 * Walks the standard JUnit-XML output directories for a workspace and
 * parses every TEST-*.xml file. Each file represents one test class with
 * multiple <testcase> children; failures/errors are marked with
 * <failure>/<error> child elements.
 *
 * The regex-based parsing here is narrower than the stdout case: JUnit XML
 * is well-defined and machine-generated, so the `<testcase>` element shape
 * is stable across decades. We don't pull in a full XML parser dependency.
 */
async function parseJUnitXmlReports(
  workspaceRoot: string,
  format: "maven" | "gradle-junit",
): Promise<ParsedTestResults | null> {
  const passing: string[] = [];
  const failing: string[] = [];
  let totalTests = 0;
  let totalErrors = 0;
  let totalFailures = 0;
  let totalSkipped = 0;
  let foundAny = false;

  for (const relDir of JUNIT_XML_SEARCH_DIRS) {
    const absDir = path.join(workspaceRoot, relDir);
    let entries: string[];
    try {
      entries = await fs.readdir(absDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".xml")) continue;
      if (!file.startsWith("TEST-") && format === "maven") continue; // surefire convention
      const filePath = path.join(absDir, file);
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }
      foundAny = true;

      // Parse the <testsuite> header counts if present — these are
      // authoritative for the suite-level totals.
      const suiteHeader = content.match(/<testsuite[^>]*>/);
      if (suiteHeader) {
        const tests = suiteHeader[0].match(/\btests="(\d+)"/);
        const errs = suiteHeader[0].match(/\berrors="(\d+)"/);
        const fails = suiteHeader[0].match(/\bfailures="(\d+)"/);
        const skips = suiteHeader[0].match(/\bskipped="(\d+)"/);
        if (tests) totalTests += Number(tests[1]);
        if (errs) totalErrors += Number(errs[1]);
        if (fails) totalFailures += Number(fails[1]);
        if (skips) totalSkipped += Number(skips[1]);
      }

      // Walk every <testcase>. Match BOTH self-closing (`<testcase ... />`)
      // and open/close (`<testcase ...> ... </testcase>`) forms so we don't
      // miss tests with associated stdout/stderr children.
      //
      // The attrs group is non-greedy + the closing alternation accepts
      // optional whitespace before `/>` — necessary because a greedy
      // `[^>]*` would consume the trailing `/` of a self-closing tag
      // and then neither branch of the alternation could match.
      const testcaseRe = /<testcase\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/testcase>)/g;
      let m: RegExpExecArray | null;
      while ((m = testcaseRe.exec(content)) !== null) {
        const attrs = m[1];
        const body = m[2] ?? "";
        const className = attrs.match(/\bclassname="([^"]+)"/)?.[1];
        const name = attrs.match(/\bname="([^"]+)"/)?.[1];
        if (!name) continue;
        const fqn = className ? `${className}.${name}` : name;
        // failure OR error child inside the body marks this case as failing.
        if (body.includes("<failure") || body.includes("<error")) {
          failing.push(fqn);
        } else if (body.includes("<skipped")) {
          // Skipped tests aren't in either bucket — they're neither
          // passing nor failing, which matches the baseline-diff semantics.
        } else {
          passing.push(fqn);
        }
      }
    }
  }

  if (!foundAny) return null;

  return {
    format,
    totalTests: totalTests > 0 ? totalTests : passing.length + failing.length,
    passingTests: passing,
    failingTests: failing,
    errorSummary:
      totalErrors + totalFailures > 0
        ? `${totalFailures} failure(s), ${totalErrors} error(s)${totalSkipped > 0 ? `, ${totalSkipped} skipped` : ""}`
        : undefined,
  };
}

// ─── pytest --json-report ──────────────────────────────────────────────────

const PYTEST_REPORT_FILES = [
  ".report.json",
  ".pytest-report.json",
  "pytest-report.json",
  "report.json",
] as const;

/**
 * Looks for the pytest-json-report plugin's output file in standard
 * locations. Plugin schema: https://pypi.org/project/pytest-json-report/
 *
 * The interesting fields:
 *   {
 *     "summary": {"total": N, "passed": M, "failed": K, ...},
 *     "tests": [
 *       {"nodeid": "tests/foo.py::test_bar", "outcome": "passed"|"failed"|"skipped"|"error", ...}
 *     ]
 *   }
 */
async function parsePytestJsonReport(
  workspaceRoot: string,
): Promise<ParsedTestResults | null> {
  for (const candidate of PYTEST_REPORT_FILES) {
    const filePath = path.join(workspaceRoot, candidate);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const root = parsed as Record<string, unknown>;
    const summary = (root.summary as Record<string, unknown> | undefined) ?? {};
    const tests = Array.isArray(root.tests) ? (root.tests as Array<Record<string, unknown>>) : [];

    const passing: string[] = [];
    const failing: string[] = [];
    for (const t of tests) {
      const nodeid = typeof t.nodeid === "string" ? t.nodeid : undefined;
      const outcome = typeof t.outcome === "string" ? t.outcome : undefined;
      if (!nodeid || !outcome) continue;
      if (outcome === "passed") passing.push(nodeid);
      else if (outcome === "failed" || outcome === "error") failing.push(nodeid);
      // skipped/xfail/xpassed don't enter either bucket — same convention
      // as the JUnit-XML adapter.
    }

    const total = typeof summary.total === "number" ? summary.total : passing.length + failing.length;
    const failedCount = typeof summary.failed === "number" ? summary.failed : failing.length;
    const errorCount = typeof summary.error === "number" ? summary.error : 0;
    const skippedCount = typeof summary.skipped === "number" ? summary.skipped : 0;

    return {
      format: "pytest-json",
      totalTests: total,
      passingTests: passing,
      failingTests: failing,
      errorSummary:
        failedCount + errorCount > 0
          ? `${failedCount} failed${errorCount > 0 ? `, ${errorCount} error(s)` : ""}${skippedCount > 0 ? `, ${skippedCount} skipped` : ""}`
          : undefined,
    };
  }
  return null;
}
