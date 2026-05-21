/**
 * M48 — Test baseline diff: pre-existing failures vs regressions.
 *
 * The RuleEngine workflow exposed pre-existing upstream test failures
 * (Map.of(null) NPE on Java 9+). With a captured baseline, those become
 * informational; without one they block approval.
 */
import { describe, expect, it } from "vitest";
import { parseTestRunnerOutput, diffTestResults } from "../src/tools/command";

const MAVEN_OUTPUT_BASELINE = `
[INFO] -------------------------------------------------------
[INFO]  T E S T S
[INFO] -------------------------------------------------------
[INFO] Running org.example.rules.RuleEngineServiceTest
[ERROR] Tests run: 19, Failures: 0, Errors: 2, Skipped: 0, Time elapsed: 0.5 s <<< FAILURE!
[ERROR] org.example.rules.RuleEngineServiceTest.testIsNotNull -- Time elapsed: 0.001 s <<< ERROR!
java.lang.NullPointerException
[ERROR] org.example.rules.RuleEngineServiceTest.testIsNull -- Time elapsed: 0.001 s <<< ERROR!
java.lang.NullPointerException
[INFO]
[INFO] Results:
[INFO]
[ERROR] Errors:
[ERROR]   RuleEngineServiceTest.testIsNotNull:167 » NullPointer
[ERROR]   RuleEngineServiceTest.testIsNull:136 » NullPointer
[INFO]
[ERROR] Tests run: 19, Failures: 0, Errors: 2, Skipped: 0
[INFO] BUILD FAILURE
`;

const MAVEN_OUTPUT_POST = `
[INFO] -------------------------------------------------------
[INFO]  T E S T S
[INFO] -------------------------------------------------------
[INFO] Running org.example.rules.RuleEngineServiceTest
[ERROR] Tests run: 22, Failures: 0, Errors: 2, Skipped: 0, Time elapsed: 0.5 s <<< FAILURE!
[ERROR] org.example.rules.RuleEngineServiceTest.testIsNotNull -- Time elapsed: 0.001 s <<< ERROR!
java.lang.NullPointerException
[ERROR] org.example.rules.RuleEngineServiceTest.testIsNull -- Time elapsed: 0.001 s <<< ERROR!
java.lang.NullPointerException
[INFO]
[ERROR] Errors:
[ERROR]   RuleEngineServiceTest.testIsNotNull:167 » NullPointer
[ERROR]   RuleEngineServiceTest.testIsNull:136 » NullPointer
[INFO]
[ERROR] Tests run: 22, Failures: 0, Errors: 2, Skipped: 0
[INFO] BUILD FAILURE
`;

const MAVEN_OUTPUT_REGRESSION = `
[ERROR] org.example.rules.RuleEngineServiceTest.testIsNotNull -- Time elapsed: 0.001 s <<< ERROR!
[ERROR] org.example.rules.RuleEngineServiceTest.testIsNull -- Time elapsed: 0.001 s <<< ERROR!
[ERROR] org.example.rules.RuleEngineServiceTest.testEqualityBasic -- Time elapsed: 0.001 s <<< ERROR!
[ERROR] Errors:
[ERROR]   RuleEngineServiceTest.testIsNotNull:167 » NullPointer
[ERROR]   RuleEngineServiceTest.testIsNull:136 » NullPointer
[ERROR]   RuleEngineServiceTest.testEqualityBasic:42 » AssertionFailedError
[ERROR] Tests run: 22, Failures: 1, Errors: 2, Skipped: 0
`;

describe("M48 parseTestRunnerOutput (Maven)", () => {
  it("extracts failing test names from Maven Surefire output", () => {
    const parsed = parseTestRunnerOutput(MAVEN_OUTPUT_BASELINE, "mvn test -Dtest=RuleEngineServiceTest");
    expect(parsed.format).toBe("maven");
    expect(parsed.failingTests).toEqual(
      expect.arrayContaining([
        "org.example.rules.RuleEngineServiceTest.testIsNotNull",
        "org.example.rules.RuleEngineServiceTest.testIsNull",
      ]),
    );
    expect(parsed.totalTests).toBe(19);
  });

  it("returns 'unparseable' for non-Maven runners", () => {
    const parsed = parseTestRunnerOutput("PASS test/foo.test.ts", "pnpm test");
    expect(parsed.format).toBe("unparseable");
  });
});

describe("M48 diffTestResults", () => {
  it("returns hasRegressions=false when post-run has identical failures to baseline", () => {
    const baseline = parseTestRunnerOutput(MAVEN_OUTPUT_BASELINE, "mvn test");
    const post = parseTestRunnerOutput(MAVEN_OUTPUT_POST, "mvn test");
    const diff = diffTestResults(baseline, post);
    expect(diff.hasRegressions).toBe(false);
    expect(diff.pre_existing_failures).toHaveLength(2);
    expect(diff.regressions).toEqual([]);
    expect(diff.fixed).toEqual([]);
  });

  it("flags regressions when post-run failures grew beyond baseline", () => {
    const baseline = parseTestRunnerOutput(MAVEN_OUTPUT_BASELINE, "mvn test");
    const post = parseTestRunnerOutput(MAVEN_OUTPUT_REGRESSION, "mvn test");
    const diff = diffTestResults(baseline, post);
    expect(diff.hasRegressions).toBe(true);
    expect(diff.pre_existing_failures).toHaveLength(2);
    expect(diff.regressions).toEqual(
      expect.arrayContaining(["org.example.rules.RuleEngineServiceTest.testEqualityBasic"]),
    );
  });

  it("returns hasRegressions=false when the agent fixed all baseline failures", () => {
    const baseline = parseTestRunnerOutput(MAVEN_OUTPUT_BASELINE, "mvn test");
    const post = parseTestRunnerOutput("[INFO] Tests run: 22, Failures: 0, Errors: 0, Skipped: 0", "mvn test");
    const diff = diffTestResults(baseline, post);
    expect(diff.hasRegressions).toBe(false);
    expect(diff.fixed).toHaveLength(2);
    expect(diff.pre_existing_failures).toEqual([]);
  });
});
