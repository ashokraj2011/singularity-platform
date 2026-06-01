/**
 * M78 Slice 1 — Unit tests for the inherited-failure analyzer.
 *
 * Each test is built around real Maven/JUnit stdout shapes captured
 * from the RuleEngine workitem audit log (the failure pattern this
 * module was designed for). The analyzer is a pure function so the
 * tests don't need any fixtures from postgres or context-fabric.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyFailures,
  derivePathCandidatesFromTestFqn,
  extractExceptionForTest,
  hintForException,
} from '../src/modules/blueprint/inherited-failure-analyzer'

describe('M78 — derivePathCandidatesFromTestFqn', () => {
  it('derives JVM test-tree candidates from a Java FQN', () => {
    const out = derivePathCandidatesFromTestFqn('org.example.rules.RuleEngineServiceTest.testIsNull')
    expect(out).toContain('src/test/java/org/example/rules/RuleEngineServiceTest.java')
    expect(out).toContain('src/test/kotlin/org/example/rules/RuleEngineServiceTest.kt')
  })

  it('handles pytest paths (already path-shaped)', () => {
    const out = derivePathCandidatesFromTestFqn('tests/test_widget.py::test_creation')
    expect(out).toEqual(['tests/test_widget.py'])
  })

  it('returns empty for malformed input', () => {
    expect(derivePathCandidatesFromTestFqn('')).toEqual([])
    expect(derivePathCandidatesFromTestFqn('justOneSegment')).toEqual([])
  })
})

describe('M78 — extractExceptionForTest', () => {
  // This is the exact format Maven surefire-text emits, captured from
  // the RuleEngine WI's failing run.
  const mavenStdout = `
[ERROR] Errors:
[ERROR]   RuleEngineServiceTest.testIsNotNull:167 » NullPointer
[ERROR]   RuleEngineServiceTest.testIsNull:136 » NullPointer
[INFO] Tests run: 13, Failures: 0, Errors: 2, Skipped: 0
`

  it('parses Maven summary line into exception + line', () => {
    const out = extractExceptionForTest(
      mavenStdout,
      'org.example.rules.RuleEngineServiceTest.testIsNull',
    )
    expect(out.exception).toBe('NullPointer')
    expect(out.exceptionLine).toBe(136)
  })

  it('returns empty object when nothing matches', () => {
    expect(extractExceptionForTest('no relevant output', 'pkg.Class.test')).toEqual({})
  })

  // Surefire-text fallback shape — the per-test report file emits this
  // when there's an Error (not a Failure).
  const surefireStdout = `
org.example.rules.RuleEngineServiceTest.testIsNull -- Time elapsed: 0.002 s <<< ERROR!
java.lang.NullPointerException
	at java.base/java.util.Objects.requireNonNull(Objects.java:233)
`

  it('falls back to head+stacktrace scanning when no summary line', () => {
    const out = extractExceptionForTest(
      surefireStdout,
      'org.example.rules.RuleEngineServiceTest.testIsNull',
    )
    expect(out.exception).toBe('NullPointerException')
  })
})

describe('M78 — hintForException', () => {
  it('flags NPE as a common Map.of/null-pointer pattern', () => {
    const hint = hintForException('NullPointerException')
    expect(hint).toMatch(/Map\.of/)
  })

  it('returns undefined for unknown exceptions', () => {
    expect(hintForException('SomeUnknownException')).toBeUndefined()
    expect(hintForException(undefined)).toBeUndefined()
  })
})

describe('M78 — classifyFailures', () => {
  // The RuleEngine WI scenario: agent touched only Operator.java and
  // RuleEngineService.java; tests testIsNull / testIsNotNull failed
  // (in the *test* file, which the agent didn't edit) — that's the
  // exact bug pattern M78 is built around.
  const ruleEngineReceipt = {
    passed: false,
    command: 'mvn test -Dtest=RuleEngineServiceTest',
    exit_code: 1,
    stdout_excerpt: `
[ERROR] Errors:
[ERROR]   RuleEngineServiceTest.testIsNotNull:167 » NullPointer
[ERROR]   RuleEngineServiceTest.testIsNull:136 » NullPointer
[INFO] Tests run: 13, Failures: 0, Errors: 2, Skipped: 0
[INFO] BUILD FAILURE
`,
    parsed_tests: {
      format: 'maven',
      failingTests: [
        'org.example.rules.RuleEngineServiceTest.testIsNull',
        'org.example.rules.RuleEngineServiceTest.testIsNotNull',
      ],
    },
  }

  it('classifies both failures as INHERITED when test file is not in agent paths', () => {
    const agentPaths = [
      'src/main/java/org/example/rules/Operator.java',
      'src/main/java/org/example/rules/RuleEngineService.java',
    ]
    const out = classifyFailures([ruleEngineReceipt], agentPaths)
    expect(out.regressionFailures).toHaveLength(0)
    expect(out.inheritedFailures).toHaveLength(2)
    const fqns = out.inheritedFailures.map(f => f.test).sort()
    expect(fqns).toEqual([
      'org.example.rules.RuleEngineServiceTest.testIsNotNull',
      'org.example.rules.RuleEngineServiceTest.testIsNull',
    ])
    // The exception + line + hint all populate.
    const first = out.inheritedFailures.find(f => f.test.endsWith('testIsNull'))
    expect(first?.exception).toBe('NullPointer')
    expect(first?.exceptionLine).toBe(136)
    expect(first?.hint).toMatch(/Map\.of/)
    expect(first?.file).toContain('src/test/java/org/example/rules/RuleEngineServiceTest.java')
  })

  it('classifies as REGRESSION when agent DID touch the test file', () => {
    const agentPaths = ['src/test/java/org/example/rules/RuleEngineServiceTest.java']
    const out = classifyFailures([ruleEngineReceipt], agentPaths)
    expect(out.regressionFailures).toHaveLength(2)
    expect(out.inheritedFailures).toHaveLength(0)
  })

  it('records unparseable when receipt has no parsed_tests', () => {
    const out = classifyFailures(
      [{ passed: false, command: 'jest', exit_code: 1, stdout_excerpt: 'whatever' }],
      [],
    )
    expect(out.unparseable.length).toBe(1)
    expect(out.unparseable[0].command).toBe('jest')
    expect(out.inheritedFailures).toHaveLength(0)
  })

  it('ignores passing receipts entirely', () => {
    const passing = { ...ruleEngineReceipt, passed: true, exit_code: 0 }
    const out = classifyFailures([passing], [])
    expect(out.inheritedFailures).toHaveLength(0)
    expect(out.regressionFailures).toHaveLength(0)
    expect(out.unparseable).toHaveLength(0)
  })

  it('dedupes test FQNs across multiple failing receipts', () => {
    const out = classifyFailures([ruleEngineReceipt, ruleEngineReceipt], [])
    // Two identical receipts → still 2 distinct failures, not 4. With empty
    // agentChangedPaths there's no provenance, so post-M90.B the two land in
    // unknownFailures (not inherited). Count across all classified buckets so
    // this stays a dedup assertion, independent of which bucket they fall in.
    const total =
      out.inheritedFailures.length +
      out.regressionFailures.length +
      out.unknownFailures.length
    expect(total).toBe(2)
  })

  it('routes failures to unknownFailures when agent provenance is empty (M90.B)', () => {
    // Regression seal for M90.B: with no agentChangedPaths, a failure can't be
    // confidently called inherited, so the gate must see it as actionable.
    const out = classifyFailures([ruleEngineReceipt], [])
    expect(out.unknownFailures).toHaveLength(2)
    expect(out.inheritedFailures).toHaveLength(0)
    expect(out.regressionFailures).toHaveLength(0)
  })
})
