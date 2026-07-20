/**
 * Dynamic reconciliation (spec §15, "Layer 2") — the pure pieces. Building the test plan a runner
 * executes, and ingesting the runner's results to refine the deterministic verdicts from
 * "declared-consistent" into "verified". No I/O here: the DB read/write + the queue live in the
 * service, so this is unit-testable in isolation.
 *
 * Verified overlay rules (test outcome is the objective signal):
 *   - a requirement whose executed tests FAIL  -> FAIL   (verified) — definitive
 *   - a requirement whose executed tests PASS  -> PASS   (verified) — but only lifts a verdict that
 *     was already PASS or PARTIAL; it never overturns a FAIL (e.g. unclaimed) or NOT_APPLICABLE
 *   - a requirement with no executed tests     -> unchanged (verified stays false)
 */

export type RunStatus = 'PASSED' | 'PARTIAL' | 'FAILED' | 'NOT_VERIFIED'

export interface TestPlanEntry {
  obligationId: string
  requirementIds: string[]
  description?: string
  command?: string
}

export interface TestResult {
  obligationId?: string
  name?: string
  requirementIds?: string[]
  status: 'PASS' | 'FAIL' | 'SKIPPED' | string
  output?: string
}

export interface CurrentVerdict {
  requirementId: string
  priority: string | null
  verdict: string
  rationale: string | null
}

export interface RefinedVerdict {
  requirementId: string
  priority: string | null
  verdict: string
  rationale: string | null
  verified: boolean
}

export interface DynamicResult {
  verdicts: RefinedVerdict[]
  status: RunStatus
  summary: {
    total: number
    pass: number
    partial: number
    fail: number
    notApplicable: number
    notVerified: number
    verified: number
    testsPassed: number
    testsFailed: number
  }
}

/**
 * Build the plan of tests a runner must execute: every test obligation that verifies at least one
 * in-scope requirement, resolved to the requirement ids it covers (from the obligation's `verifies`
 * plus any requirement that references the obligation).
 */
export function buildTestPlan(input: {
  requirements: { id: string; testObligationIds: string[] }[]
  testObligations: { id: string; verifies?: string[]; description?: string; command?: string }[]
  scopeRequirementIds: string[]
}): TestPlanEntry[] {
  const scope = new Set(input.scopeRequirementIds.length ? input.scopeRequirementIds : input.requirements.map((r) => r.id))
  const byObligation = new Map<string, Set<string>>()
  const add = (obligationId: string, reqId: string) => {
    if (!scope.has(reqId)) return
    if (!byObligation.has(obligationId)) byObligation.set(obligationId, new Set())
    byObligation.get(obligationId)!.add(reqId)
  }
  for (const o of input.testObligations) for (const reqId of o.verifies ?? []) add(o.id, reqId)
  for (const r of input.requirements) for (const oid of r.testObligationIds) add(oid, r.id)

  return input.testObligations
    .filter((o) => (byObligation.get(o.id)?.size ?? 0) > 0)
    .map((o) => ({
      obligationId: o.id,
      requirementIds: [...(byObligation.get(o.id) ?? [])],
      ...(o.description ? { description: o.description } : {}),
      ...(o.command ? { command: o.command } : {}),
    }))
}

/** Fold runner test results over the deterministic verdicts, producing the verified verdict matrix. */
export function applyTestResults(current: CurrentVerdict[], results: TestResult[]): DynamicResult {
  const perReq = new Map<string, { ran: number; pass: number; fail: number }>()
  let testsPassed = 0
  let testsFailed = 0
  for (const r of results) {
    if (r.status === 'PASS') testsPassed++
    else if (r.status === 'FAIL') testsFailed++
    if (r.status !== 'PASS' && r.status !== 'FAIL') continue // SKIPPED / unknown don't gate a requirement
    for (const id of r.requirementIds ?? []) {
      const agg = perReq.get(id) ?? { ran: 0, pass: 0, fail: 0 }
      agg.ran++
      if (r.status === 'PASS') agg.pass++
      else agg.fail++
      perReq.set(id, agg)
    }
  }

  const verdicts: RefinedVerdict[] = current.map((v) => {
    const agg = perReq.get(v.requirementId)
    if (!agg || agg.ran === 0) return { ...v, verified: false }
    if (agg.fail > 0) {
      return { requirementId: v.requirementId, priority: v.priority, verdict: 'FAIL', rationale: `Verified: ${agg.fail} of ${agg.ran} executed test(s) failed.`, verified: true }
    }
    // All executed tests passed — lift PASS/PARTIAL to a verified PASS; leave FAIL / NOT_APPLICABLE.
    if (v.verdict === 'PASS' || v.verdict === 'PARTIAL') {
      return { requirementId: v.requirementId, priority: v.priority, verdict: 'PASS', rationale: `Verified: ${agg.pass} of ${agg.ran} executed test(s) passed.`, verified: true }
    }
    return { ...v, verified: true }
  })

  const count = (val: string) => verdicts.filter((v) => v.verdict === val).length
  const mustFail = verdicts.some((v) => v.priority === 'MUST' && v.verdict === 'FAIL')
  const anyFail = verdicts.some((v) => v.verdict === 'FAIL')
  const anyPartial = verdicts.some((v) => v.verdict === 'PARTIAL')
  // Passing tests do not lift a NOT_VERIFIED verdict (see the overlay above), so a matrix that
  // still holds one was never assessed — it must not roll up to PASSED, which is the only status
  // `dynamicCompletionOutcome` will promote to VERIFIED_PASS.
  const anyNotVerified = verdicts.some((v) => v.verdict === 'NOT_VERIFIED')
  const status: RunStatus = mustFail
    ? 'FAILED'
    : anyFail || anyPartial
      ? 'PARTIAL'
      : anyNotVerified || verdicts.length === 0
        ? 'NOT_VERIFIED'
        : 'PASSED'

  return {
    verdicts,
    status,
    summary: {
      total: verdicts.length,
      pass: count('PASS'),
      partial: count('PARTIAL'),
      fail: count('FAIL'),
      notApplicable: count('NOT_APPLICABLE'),
      notVerified: count('NOT_VERIFIED'),
      verified: verdicts.filter((v) => v.verified).length,
      testsPassed,
      testsFailed,
    },
  }
}
