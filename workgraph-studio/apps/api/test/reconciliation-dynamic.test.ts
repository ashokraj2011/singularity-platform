import { describe, it, expect } from 'vitest'
import { buildTestPlan, applyTestResults, type CurrentVerdict } from '../src/modules/reconciliations/reconciliation.dynamic'

describe('buildTestPlan', () => {
  const requirements = [
    { id: 'REQ-1', testObligationIds: ['T-1'] },
    { id: 'REQ-2', testObligationIds: [] },
    { id: 'REQ-OUT', testObligationIds: ['T-3'] },
  ]
  const testObligations = [
    { id: 'T-1', verifies: ['REQ-1'], description: 'unit', command: 'npm test -- REQ-1' },
    { id: 'T-2', verifies: ['REQ-2'] },
    { id: 'T-3', verifies: ['REQ-OUT'] },
  ]

  it('includes only obligations that verify an in-scope requirement, with resolved requirement ids', () => {
    const plan = buildTestPlan({ requirements, testObligations, scopeRequirementIds: ['REQ-1', 'REQ-2'] })
    const ids = plan.map((p) => p.obligationId).sort()
    expect(ids).toEqual(['T-1', 'T-2'])
    expect(plan.find((p) => p.obligationId === 'T-1')?.requirementIds).toEqual(['REQ-1'])
    expect(plan.find((p) => p.obligationId === 'T-1')?.command).toBe('npm test -- REQ-1')
  })

  it('resolves requirement ids from requirement.testObligationIds as well as obligation.verifies', () => {
    const plan = buildTestPlan({
      requirements: [{ id: 'REQ-9', testObligationIds: ['T-9'] }],
      testObligations: [{ id: 'T-9' }], // no verifies — the mapping comes from the requirement
      scopeRequirementIds: [],
    })
    expect(plan).toHaveLength(1)
    expect(plan[0].requirementIds).toEqual(['REQ-9'])
  })
})

describe('applyTestResults', () => {
  const current: CurrentVerdict[] = [
    { requirementId: 'REQ-1', priority: 'MUST', verdict: 'PASS', rationale: 'declared' },
    { requirementId: 'REQ-2', priority: 'SHOULD', verdict: 'PARTIAL', rationale: 'missing test evidence' },
  ]

  it('marks a requirement FAIL (verified) when its executed tests fail', () => {
    const r = applyTestResults(current, [{ obligationId: 'T-1', requirementIds: ['REQ-1'], status: 'FAIL' }])
    const v1 = r.verdicts.find((v) => v.requirementId === 'REQ-1')!
    expect(v1.verdict).toBe('FAIL')
    expect(v1.verified).toBe(true)
    expect(r.status).toBe('FAILED') // REQ-1 is MUST
  })

  it('lifts a PARTIAL requirement to a verified PASS when its executed tests pass', () => {
    const r = applyTestResults(current, [
      { requirementIds: ['REQ-1'], status: 'PASS' },
      { requirementIds: ['REQ-2'], status: 'PASS' },
    ])
    expect(r.verdicts.find((v) => v.requirementId === 'REQ-2')!.verdict).toBe('PASS')
    expect(r.verdicts.every((v) => v.verified)).toBe(true)
    expect(r.status).toBe('PASSED')
    expect(r.summary.verified).toBe(2)
    expect(r.summary.testsPassed).toBe(2)
  })

  it('leaves a requirement unchanged and unverified when no test covered it', () => {
    const r = applyTestResults(current, [{ requirementIds: ['REQ-1'], status: 'PASS' }])
    const v2 = r.verdicts.find((v) => v.requirementId === 'REQ-2')!
    expect(v2.verdict).toBe('PARTIAL')
    expect(v2.verified).toBe(false)
    expect(r.status).toBe('PARTIAL') // REQ-2 still partial
  })

  it('ignores SKIPPED results (they neither pass nor fail a requirement)', () => {
    const r = applyTestResults(current, [{ requirementIds: ['REQ-2'], status: 'SKIPPED' }])
    expect(r.verdicts.find((v) => v.requirementId === 'REQ-2')!.verified).toBe(false)
    expect(r.summary.testsPassed).toBe(0)
    expect(r.summary.testsFailed).toBe(0)
  })
})
