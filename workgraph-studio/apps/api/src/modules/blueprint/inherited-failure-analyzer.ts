/**
 * M78 Slice 1 — Classify each failed test on a develop attempt as either
 * a REGRESSION (file the agent touched) or INHERITED (file in upstream
 * that the agent didn't change).
 *
 * The classification flips the platform's response to a failed approval
 * from "human, figure it out" to a structured payload the workbench can
 * render as actionable cards — and, in later slices, the basis for
 * auto-creating remediation work items.
 *
 * Inputs:
 *   - verificationReceipts: the receipts already on the attempt. The
 *     M72 Slice D structured test report parser populates
 *     `parsed_tests.failingTests` with FQNs like `pkg.Class.method`.
 *   - agentChangedPaths: file paths the agent actually mutated this
 *     attempt, resolved from attempt.correlation.codeChangeIds via
 *     contextFabricClient.listCodeChanges(). Already lowercased+normalised
 *     by the caller.
 *
 * Output: { inheritedFailures[], regressionFailures[], unparseable[] }.
 * `unparseable` exists so we don't silently drop receipts whose structured
 * data didn't survive (e.g. a Jest run before the structured-parser path
 * supports it). The caller decides whether to surface that bucket too.
 *
 * Path derivation is heuristic — JVM packages map to directories, but
 * test files could live under src/test/java, src/test/kotlin, or
 * src/test/groovy. We probe all three and pick the first that matches a
 * known agent-changed path; if none match, we record the most likely
 * candidate (src/test/java) so the downstream remediation prompt has a
 * concrete path to anchor on.
 */

export interface ParsedTestData {
  failingTests?: string[]
  format?: string
}

export interface VerificationReceiptForAnalysis {
  passed?: boolean | null
  command?: string | null
  exit_code?: number | null
  stdout_excerpt?: string | null
  parsed_tests?: ParsedTestData | null
}

export interface InheritedFailure {
  test: string                 // FQN, e.g. org.example.RuleEngineServiceTest.testIsNull
  file: string                 // derived test file path
  exception?: string           // e.g. "NullPointerException" — best-effort from stdout
  exceptionLine?: number       // line in `file` where the test starts — best-effort
  hint?: string                // human-readable explanation, e.g. "Map.of() rejects null values"
}

export interface FailureClassification {
  inheritedFailures: InheritedFailure[]
  regressionFailures: InheritedFailure[]
  unparseable: Array<{ command: string; reason: string }>
}

/**
 * Derive candidate file paths from a JVM-style FQN test name.
 *
 * `org.example.rules.RuleEngineServiceTest.testIsNull` →
 *   [
 *     "src/test/java/org/example/rules/RuleEngineServiceTest.java",
 *     "src/test/kotlin/org/example/rules/RuleEngineServiceTest.kt",
 *     "src/test/groovy/org/example/rules/RuleEngineServiceTest.groovy",
 *   ]
 *
 * For pytest-style names (`tests/foo_test.py::test_something`) the input is
 * already a path, so we return it as-is.
 */
export function derivePathCandidatesFromTestFqn(fqn: string): string[] {
  if (!fqn) return []
  // pytest: `tests/foo_test.py::test_x` — already a path.
  if (fqn.includes('::')) {
    return [fqn.split('::')[0]]
  }
  // JVM FQN: pkg.subpkg.ClassName.methodName → strip methodName, replace dots with /.
  const parts = fqn.split('.')
  if (parts.length < 2) return []
  // Conservative: drop the last segment (the test method name).
  const classParts = parts.slice(0, -1)
  const dir = classParts.slice(0, -1).join('/')
  const className = classParts[classParts.length - 1]
  if (!className) return []
  const base = dir ? `${dir}/${className}` : className
  return [
    `src/test/java/${base}.java`,
    `src/test/kotlin/${base}.kt`,
    `src/test/groovy/${base}.groovy`,
    // Some repos use the production tree layout under tests; cover it too.
    `test/java/${base}.java`,
  ]
}

/**
 * Best-effort extraction of the exception class name + line number from
 * a Maven/Gradle/pytest stdout excerpt for a given test FQN.
 *
 * Looks for patterns like:
 *   `[ERROR]   RuleEngineServiceTest.testIsNull:136 » NullPointer`
 *   `org.example.rules.RuleEngineServiceTest.testIsNull -- ... <<< ERROR!`
 *   followed by `java.lang.NullPointerException`
 *
 * Returns whatever it can find. Null when nothing matches — fine,
 * downstream UI degrades gracefully.
 */
export function extractExceptionForTest(
  stdout: string,
  testFqn: string,
): { exception?: string; exceptionLine?: number } {
  if (!stdout || !testFqn) return {}
  const parts = testFqn.split('.')
  const methodName = parts[parts.length - 1]
  const className = parts[parts.length - 2]
  if (!methodName || !className) return {}

  // Maven summary line: `  ClassName.testMethod:LINE » ExceptionShortName`
  const summaryRe = new RegExp(
    `\\b${escapeRegex(className)}\\.${escapeRegex(methodName)}:(\\d+)\\s+»\\s+(\\w+)`,
  )
  const summaryMatch = stdout.match(summaryRe)
  if (summaryMatch) {
    return {
      exception: summaryMatch[2],
      exceptionLine: Number(summaryMatch[1]),
    }
  }

  // Surefire-text fallback: line with `ClassName.methodName -- Time elapsed...`
  // followed within a few lines by `java.lang.Xxx` or similar.
  const headRe = new RegExp(
    `${escapeRegex(className)}\\.${escapeRegex(methodName)}\\b[^\\n]*<<<\\s*ERROR`,
  )
  const headIdx = stdout.search(headRe)
  if (headIdx >= 0) {
    const after = stdout.slice(headIdx, headIdx + 800)
    const excRe = /(?:java|kotlin|org|com)\.[A-Za-z0-9_.$]+(?:Exception|Error)/
    const m = after.match(excRe)
    if (m) {
      return { exception: shortenException(m[0]) }
    }
  }
  return {}
}

/**
 * Map an exception class name to a plain-English hint about the most
 * common cause. Keeps the UI readable for non-Java folks. Best-effort —
 * unknown exceptions just don't get a hint, no harm.
 */
export function hintForException(exception?: string): string | undefined {
  if (!exception) return undefined
  const lower = exception.toLowerCase()
  if (lower.includes('nullpointer')) {
    return 'NullPointerException — often Map.of(null) / List.of(null) (Java 9+ rejects nulls), or an unchecked null dereference in setup.'
  }
  if (lower.includes('illegalargument')) {
    return 'IllegalArgumentException at construction — check arguments passed to test fixtures.'
  }
  if (lower.includes('illegalstate')) {
    return 'IllegalStateException — fixture or setup invariant violated.'
  }
  if (lower.includes('classcast')) {
    return 'ClassCastException — generic type mismatch in test data construction.'
  }
  if (lower.includes('comparisonfailure') || lower.includes('assertionerror')) {
    return 'Assertion failed — expected vs actual diverged. Usually a real product-code issue, not a fixture bug.'
  }
  return undefined
}

/**
 * The main classifier. Walks every failed test across all receipts and
 * assigns it to inherited or regression.
 */
export function classifyFailures(
  receipts: VerificationReceiptForAnalysis[],
  agentChangedPaths: string[],
): FailureClassification {
  const result: FailureClassification = {
    inheritedFailures: [],
    regressionFailures: [],
    unparseable: [],
  }

  // Normalise once: agentChangedPaths comes from paths_touched lists; we
  // strip leading "./" and lowercase for case-insensitive matching on
  // case-insensitive filesystems (Windows checkouts, macOS default).
  const agentPathSet = new Set(
    agentChangedPaths.map(p => normalisePath(p)).filter(Boolean),
  )

  const seen = new Set<string>()  // dedupe across receipts

  for (const receipt of receipts) {
    if (receipt.passed !== false && (receipt.exit_code ?? 0) === 0) continue
    const parsed = receipt.parsed_tests
    const failing = Array.isArray(parsed?.failingTests) ? parsed?.failingTests ?? [] : []
    if (failing.length === 0) {
      result.unparseable.push({
        command: receipt.command ?? '(unknown)',
        reason: 'No structured failingTests list on this receipt (parser may not support the runner).',
      })
      continue
    }
    const stdout = receipt.stdout_excerpt ?? ''
    for (const testFqn of failing) {
      if (seen.has(testFqn)) continue
      seen.add(testFqn)
      const candidates = derivePathCandidatesFromTestFqn(testFqn)
      // Pick the first candidate that matches a path the agent touched.
      // If none match, default to the most-likely candidate (first in
      // the list) — that's still the right place to write the
      // remediation later, even if the agent didn't touch it.
      const matched = candidates.find(c => agentPathSet.has(normalisePath(c)))
      const filePath = matched ?? candidates[0] ?? ''
      const isRegression = Boolean(matched)
      const { exception, exceptionLine } = extractExceptionForTest(stdout, testFqn)
      const failure: InheritedFailure = {
        test: testFqn,
        file: filePath,
        exception,
        exceptionLine,
        hint: hintForException(exception),
      }
      if (isRegression) {
        result.regressionFailures.push(failure)
      } else {
        result.inheritedFailures.push(failure)
      }
    }
  }
  return result
}

function normalisePath(p: string): string {
  if (!p) return ''
  let out = p.replace(/\\/g, '/').toLowerCase()
  while (out.startsWith('./')) out = out.slice(2)
  out = out.replace(/^\/+/, '')
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function shortenException(fq: string): string {
  // java.lang.NullPointerException → NullPointerException
  const parts = fq.split('.')
  return parts[parts.length - 1] ?? fq
}
