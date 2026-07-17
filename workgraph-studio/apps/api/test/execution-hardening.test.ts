import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertIndependentSpecificationApprover } from '../src/modules/specifications/specifications.service'
import {
  dynamicCompletionOutcome,
  expiredReconciliationJobDisposition,
  supersededSpecificationFinding,
} from '../src/modules/reconciliations/reconciliations.service'
import {
  CLAIMABLE_WORK_ITEM_TARGET_STATUSES,
  reworkTargetResetData,
} from '../src/modules/work-items/work-items.service'
import { isCurrentVerifiedScopeRun } from '../src/modules/work-items/work-item-finalizer.service'

describe('contract-bound execution hardening', () => {
  it('enforces independent specification approval', () => {
    expect(() => assertIndependentSpecificationApprover('author-1', 'author-1')).toThrow(/cannot approve/i)
    expect(() => assertIndependentSpecificationApprover('author-1', 'reviewer-1')).not.toThrow()
  })

  it('resets a rework target so it can be claimed and started with a fresh child run', () => {
    const reset = reworkTargetResetData()
    expect(reset).toMatchObject({
      status: 'REWORK_REQUESTED',
      claimedById: null,
      childWorkflowInstanceId: null,
      submittedAt: null,
      completedAt: null,
    })
    expect(CLAIMABLE_WORK_ITEM_TARGET_STATUSES.has(reset.status)).toBe(true)
  })

  it('records a warning instead of crashing for a superseded specification', () => {
    expect(supersededSpecificationFinding('SUPERSEDED', 3)).toMatchObject({
      kind: 'superseded-specification',
      severity: 'WARNING',
    })
    expect(supersededSpecificationFinding('APPROVED', 3)).toBeNull()
  })

  it('never verifies an all-skipped dynamic plan', () => {
    const outcome = dynamicCompletionOutcome(2, [{ status: 'SKIPPED' }, { status: 'SKIPPED' }], 'PASSED')
    expect(outcome).toMatchObject({
      completePlan: true,
      allPassed: false,
      allSkipped: true,
      status: 'PARTIAL',
      reconciliationState: 'NOT_VERIFIED',
    })
  })

  it('accepts verification evidence only for the latest submission in the current scope contract', () => {
    const scope = { id: 'scope-1', specificationBindingId: 'binding-2', currentHandoffGenerationId: 'handoff-4' }
    const run = {
      submissionId: 'submission-old',
      status: 'VERIFIED_PASS',
      reconciliationState: 'VERIFIED',
      developmentScopeId: 'scope-1',
      specificationBindingId: 'binding-2',
      handoffGenerationId: 'handoff-4',
    }
    expect(isCurrentVerifiedScopeRun(run, scope, 'submission-new')).toBe(false)
    expect(isCurrentVerifiedScopeRun({ ...run, submissionId: 'submission-new' }, scope, 'submission-new')).toBe(true)
    expect(isCurrentVerifiedScopeRun({ ...run, submissionId: 'submission-new', reconciliationState: 'STALE' }, scope, 'submission-new')).toBe(false)
  })

  it('requeues expired leases until the retry budget is exhausted', () => {
    expect(expiredReconciliationJobDisposition(1, 3)).toBe('PENDING')
    expect(expiredReconciliationJobDisposition(3, 3)).toBe('DEAD_LETTERED')
  })
})

describe('legacy child-resource authorization coverage', () => {
  const cases = [
    ['specifications.router.ts', 'specificationsRouter.', 'await authorize(req'],
    ['../submissions/submissions.router.ts', 'submissionsRouter.', 'await loadAuthorizedWorkItem('],
    ['../reconciliations/reconciliations.router.ts', 'reconciliationsRouter.', 'await loadAuthorizedWorkItem('],
    ['../development-targets/development-targets.router.ts', 'developmentTargetsRouter.', 'await loadAuthorizedWorkItem('],
  ] as const

  for (const [relativePath, routeMarker, guardMarker] of cases) {
    it(`guards every route in ${relativePath.split('/').at(-1)}`, () => {
      const url = relativePath.startsWith('..')
        ? new URL(`../src/modules/specifications/${relativePath}`, import.meta.url)
        : new URL(`../src/modules/specifications/${relativePath}`, import.meta.url)
      const source = readFileSync(url, 'utf8')
      expect(source.split(routeMarker).length - 1).toBe(source.split(guardMarker).length - 1)
    })
  }
})
