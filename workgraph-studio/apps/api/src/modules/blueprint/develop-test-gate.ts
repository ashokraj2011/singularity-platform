/**
 * Develop test gate — the "real" hard gate behind the unit-test mandate.
 *
 * A stage that OWNS unit tests (declares a required `unit_tests` expected
 * artifact) cannot be approved unless the latest attempt shows BOTH:
 *   1. a test file among the files the agent actually edited, AND
 *   2. a passing test RUN in its verification receipts (not lint/compile-only,
 *      and not a "no tests ran" filter miss).
 *
 * This is stronger than gating on the auto-generated `unit_tests` artifact
 * (which is always produced and proves nothing). Pure + dependency-free so it
 * unit-tests without the DB or the blueprint router; the router supplies the
 * changed paths (via context-fabric listCodeChanges) and the receipts.
 */

export interface ExpectedArtifactLike { kind: string; required?: boolean }

/** True when the stage declares a REQUIRED unit_tests artifact, i.e. it owns tests. */
export function stageRequiresUnitTests(expectedArtifacts: ExpectedArtifactLike[] | undefined): boolean {
  return (expectedArtifacts ?? []).some(a => a.kind === 'unit_tests' && a.required !== false)
}

/** Heuristic: does this repo path look like a test file? Covers JS/TS, Java/Kotlin,
 *  Python, Go, Ruby, C#, Scala/Groovy conventions. */
export function isTestPath(path: string): boolean {
  if (typeof path !== 'string' || !path.trim()) return false
  const p = path.trim().replace(/\\/g, '/')
  return (
    /(^|\/)(tests?|__tests__|spec|specs)\//i.test(p) ||           // test/ tests/ __tests__/ spec/
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p) ||                    // foo.test.ts, foo.spec.jsx
    /Tests?\.(java|kt|cs|scala)$/i.test(p) ||                     // FooTest.java, FooTests.kt
    /(^|\/)test_[^/]+\.py$/i.test(p) || /_test\.py$/i.test(p) ||  // test_foo.py, foo_test.py
    /_test\.go$/i.test(p) ||                                      // foo_test.go
    /(_spec|Spec)\.(rb|scala|groovy)$/i.test(p)                   // foo_spec.rb, FooSpec.groovy
  )
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** A verification receipt that represents an actual TEST run that PASSED. */
export function isPassingTestReceipt(r: Record<string, unknown>): boolean {
  if (!r || typeof r !== 'object') return false
  // A filter that matched zero tests is NOT a passing test run.
  if (r.no_tests_ran_reason) return false
  const exit = num(r.exit_code) ?? num(r.exitCode)
  const passed = r.passed === true || (r.passed !== false && exit === 0)
  if (!passed) return false
  // Must look like a test run (not lint/typecheck/compile-only).
  const cmd = typeof r.command === 'string' ? r.command.toLowerCase() : ''
  const isTestCmd =
    /\b(pytest|jest|vitest|mocha|rspec|phpunit|tox|ctest)\b/.test(cmd) ||
    /\bgo\s+test\b/.test(cmd) ||
    /\b(mvn|maven)\b[^\n]*\btest\b/.test(cmd) ||
    /\bgradle[w]?\b[^\n]*\btest\b/.test(cmd) ||
    /\b(npm|yarn|pnpm)\b[^\n]*\btest\b/.test(cmd) ||
    /\btest\b/.test(cmd)
  const kind = typeof r.verification_kind === 'string' ? r.verification_kind.toLowerCase() : ''
  const parsed = (r.parsedTests ?? r.parsed_tests) as { total?: unknown } | undefined
  const parsedTotal = parsed && typeof parsed === 'object' ? num((parsed as { total?: unknown }).total) : null
  const ranTests = isTestCmd || kind === 'test' || (parsedTotal != null && parsedTotal > 0) || r.targeted_tests === true
  return ranTests
}

export interface DevelopTestGateResult {
  ok: boolean
  testFileEdited: boolean
  passingTestRun: boolean
  reason?: string
}

/**
 * Evaluate the gate. `pathsKnown=false` means we couldn't resolve the agent's
 * edited paths (e.g. context-fabric was unreachable) — in that case we fail OPEN
 * on the test-file requirement (don't block on infra), but STILL require a
 * passing test run, which is local receipt data.
 */
export function evaluateDevelopTestGate(args: {
  changedPaths: string[]
  pathsKnown: boolean
  receipts: Array<Record<string, unknown>>
}): DevelopTestGateResult {
  const testFileEdited = (args.changedPaths ?? []).some(isTestPath)
  const passingTestRun = (args.receipts ?? []).some(isPassingTestReceipt)

  const needTestFile = args.pathsKnown // only enforce when we actually know the paths
  const ok = passingTestRun && (!needTestFile || testFileEdited)

  let reason: string | undefined
  if (!ok) {
    const missing: string[] = []
    if (needTestFile && !testFileEdited) missing.push('no test file was added or modified in this attempt')
    if (!passingTestRun) missing.push('no passing test RUN was captured (lint/compile/“no tests ran” do not count)')
    reason =
      `Develop owns unit tests: ${missing.join(' and ')}. ` +
      `Re-run Develop — add/extend unit tests for the new behavior and run them green (run_test) before approving. ` +
      `(Set WORKBENCH_REQUIRE_UNIT_TESTS=false to disable this gate.)`
  }
  return { ok, testFileEdited, passingTestRun, reason }
}
