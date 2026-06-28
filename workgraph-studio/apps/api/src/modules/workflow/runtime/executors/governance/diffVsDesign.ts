/**
 * DIFF_VS_DESIGN — validate a captured code-change diff against a design
 * artifact's `diffValidation` contract. Pure + unit-tested; the diff and the
 * contract are fetched by the gate's evidence checker at runtime (the control is
 * "satisfied" when there are zero violations).
 */

export interface CapturedDiff {
  pathsTouched: string[]
}

export interface DiffValidation {
  /** glob-ish ('*' = any run of chars); any touched path matching → violation. */
  forbiddenPaths?: string[]
  /** each pattern must be matched by at least one touched path. */
  requiredPathPatterns?: string[]
  /** require at least one changed test file. */
  requireTests?: boolean
  /** RegExp source overriding the default test-file detector. */
  testPathPattern?: string
}

export interface DiffViolation {
  kind: 'missing-contract' | 'no-diff' | 'forbidden-path' | 'missing-required-path' | 'missing-tests'
  detail: string
}

const DEFAULT_TEST_PATTERN = '(\\.test\\.|\\.spec\\.|_test\\.|/tests?/)'

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp('^' + esc + '$')
}

export function evaluateDiffVsDesign(
  diff: CapturedDiff | null | undefined,
  dv: DiffValidation | null | undefined,
): DiffViolation[] {
  const out: DiffViolation[] = []
  if (!dv) {
    out.push({ kind: 'missing-contract', detail: 'design artifact has no diffValidation contract' })
    return out
  }
  const paths = Array.isArray(diff?.pathsTouched) ? diff!.pathsTouched : []
  if (paths.length === 0) {
    out.push({ kind: 'no-diff', detail: 'no captured code-change diff to validate' })
    return out
  }
  for (const p of paths) {
    if (dv.forbiddenPaths?.length && dv.forbiddenPaths.some(g => globToRegExp(g).test(p))) {
      out.push({ kind: 'forbidden-path', detail: `changed path is forbidden by design: ${p}` })
    }
  }
  for (const req of dv.requiredPathPatterns ?? []) {
    if (!paths.some(p => globToRegExp(req).test(p))) {
      out.push({ kind: 'missing-required-path', detail: `no changed path matches required pattern: ${req}` })
    }
  }
  if (dv.requireTests) {
    const re = new RegExp(dv.testPathPattern ?? DEFAULT_TEST_PATTERN)
    if (!paths.some(p => re.test(p))) {
      out.push({ kind: 'missing-tests', detail: 'design requires tests but no test file was changed' })
    }
  }
  return out
}
