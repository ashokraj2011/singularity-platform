import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * RECONCILE node. The point of these tests is the VERDICT MAPPING, not the plumbing:
 * an unproven run must never advance a workflow as if it were verified, and it must
 * never be recorded the same way a real failure is.
 */

const workItemFindUnique = vi.fn()
const submissionFindFirst = vi.fn()
const submissionFindUnique = vi.fn()
const nodeUpdate = vi.fn(async () => ({}))
const instanceUpdate = vi.fn(async () => ({}))
const mutationCreate = vi.fn(async () => ({}))
const startReconciliation = vi.fn()
const logEvent = vi.fn()
const publishOutbox = vi.fn()

vi.mock('../src/lib/prisma', () => ({
  prisma: {
    workItem: { findUnique: (...a: unknown[]) => workItemFindUnique(...a) },
    implementationSubmission: {
      findFirst: (...a: unknown[]) => submissionFindFirst(...a),
      findUnique: (...a: unknown[]) => submissionFindUnique(...a),
    },
    workflowNode: { update: (...a: unknown[]) => nodeUpdate(...a) },
    workflowInstance: { update: (...a: unknown[]) => instanceUpdate(...a) },
    workflowMutation: { create: (...a: unknown[]) => mutationCreate(...a) },
  },
}))
vi.mock('../src/lib/tenant-db-context', () => ({
  withTenantDbTransaction: (p: unknown, fn: (tx: unknown) => unknown) => fn(p),
  currentTenantIdForDb: () => 'default',
}))
vi.mock('../src/lib/audit', () => ({
  logEvent: (...a: unknown[]) => logEvent(...a),
  publishOutbox: (...a: unknown[]) => publishOutbox(...a),
}))
vi.mock('../src/modules/reconciliations/reconciliations.service', () => ({
  startReconciliation: (...a: unknown[]) => startReconciliation(...a),
}))

import { activateReconcile, reconcileOutcomeFor } from '../src/modules/workflow/runtime/executors/ReconcileExecutor'

const node = (config: Record<string, unknown> = {}) =>
  ({ id: 'n1', nodeType: 'RECONCILE', status: 'ACTIVE', config } as any)
const instance = (over: Record<string, unknown> = {}) =>
  ({
    id: 'run1',
    tenantId: 'default',
    createdById: 'creator-1',
    context: { _workItem: { workCode: 'WI-1' } },
    ...over,
  } as any)

function run(status: string, extra: Record<string, unknown> = {}) {
  return {
    run: { id: 'recon-1', status, mode: 'DETERMINISTIC' },
    verdicts: [{ requirementId: 'R1' }],
    findings: [],
    summary: { total: 1 },
    ...extra,
  }
}

/** The mutation type written by the last halt(), i.e. how the outcome is recorded. */
const lastMutationType = () => mutationCreate.mock.calls.at(-1)?.[0]?.data?.mutationType
const lastEventType = () => logEvent.mock.calls.at(-1)?.[0]

beforeEach(() => {
  vi.clearAllMocks()
  workItemFindUnique.mockResolvedValue({ id: 'wi-1', workCode: 'WI-1' })
  submissionFindFirst.mockResolvedValue({ id: 'sub-1', status: 'ACCEPTED', headCommitSha: 'abc1234' })
})

describe('reconcileOutcomeFor — which run statuses advance a workflow', () => {
  it('advances only on an executed, fully passing plan', () => {
    for (const s of ['VERIFIED_PASS', 'PASSED']) {
      expect(reconcileOutcomeFor(s)).toMatchObject({ status: 'VERIFIED', advance: true, unproven: false })
    }
  })

  it('advances a declaration check as DECLARED, never as VERIFIED', () => {
    for (const s of ['DECLARED_CONSISTENT', 'SEMANTICALLY_REVIEWED']) {
      expect(reconcileOutcomeFor(s)).toMatchObject({ status: 'DECLARED', advance: true, unproven: false })
    }
  })

  it('refuses a declaration check when requireVerifiedPass is set', () => {
    for (const s of ['DECLARED_CONSISTENT', 'SEMANTICALLY_REVIEWED']) {
      expect(reconcileOutcomeFor(s, { requireVerifiedPass: true }))
        .toMatchObject({ status: 'NOT_VERIFIED', advance: false, unproven: true })
    }
  })

  it('never advances an unproven run', () => {
    for (const s of ['NOT_VERIFIED', 'PENDING', 'RUNNING']) {
      expect(reconcileOutcomeFor(s).advance).toBe(false)
      expect(reconcileOutcomeFor(s).unproven).toBe(true)
    }
  })

  it('never advances a measured failure, and does not call it unproven', () => {
    for (const s of ['FAILED', 'PARTIAL', 'ERROR', 'CANCELLED']) {
      expect(reconcileOutcomeFor(s)).toMatchObject({ status: 'FAILED', advance: false, unproven: false })
    }
  })

  it('separates "measured nothing" from "measured and failed" in status, flag and prose', () => {
    const unproven = reconcileOutcomeFor('NOT_VERIFIED')
    const failed = reconcileOutcomeFor('FAILED')
    expect(unproven.status).not.toBe(failed.status)
    expect(unproven.unproven).toBe(true)
    expect(failed.unproven).toBe(false)
    expect(unproven.outcome).toMatch(/MEASURED NOTHING/)
    expect(unproven.outcome).toMatch(/not a failure/i)
    expect(failed.outcome).toMatch(/WAS measured/)
  })

  it('halts rather than guesses on an unrecognised status', () => {
    expect(reconcileOutcomeFor('SOMETHING_NEW')).toMatchObject({ status: 'HALTED', advance: false })
  })
})

describe('activateReconcile', () => {
  it('advances the node on a PASSED run with a complete test plan', async () => {
    startReconciliation.mockResolvedValue(run('VERIFIED_PASS'))
    const result = await activateReconcile(node(), instance(), 'clicker-1')

    expect(result.passed).toBe(true)
    expect(result.output.reconcile).toMatchObject({
      status: 'VERIFIED',
      unproven: false,
      runStatus: 'VERIFIED_PASS',
      reconciliationRunId: 'recon-1',
      workItemId: 'wi-1',
      submissionId: 'sub-1',
    })
    // An advance must not park or pause the run.
    expect(nodeUpdate).not.toHaveBeenCalled()
    expect(instanceUpdate).not.toHaveBeenCalled()
    expect(lastEventType()).toBe('ReconcileVerified')
  })

  it('does NOT advance a NOT_VERIFIED run, and blocks it as unproven', async () => {
    startReconciliation.mockResolvedValue(run('NOT_VERIFIED'))
    const result = await activateReconcile(node(), instance(), 'clicker-1')

    expect(result.passed).toBe(false)
    expect(result.output.reconcile).toMatchObject({ status: 'NOT_VERIFIED', unproven: true })
    expect(nodeUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'BLOCKED' }) }))
    expect(instanceUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PAUSED' }) }))
    expect(lastMutationType()).toBe('RECONCILE_NOT_VERIFIED')
    expect(lastEventType()).toBe('ReconcileNotVerified')
  })

  it('records a NOT_VERIFIED run differently from a FAILED one', async () => {
    startReconciliation.mockResolvedValue(run('NOT_VERIFIED'))
    const unproven = await activateReconcile(node(), instance(), 'clicker-1')
    const unprovenMutation = lastMutationType()
    const unprovenEvent = lastEventType()

    vi.clearAllMocks()
    workItemFindUnique.mockResolvedValue({ id: 'wi-1', workCode: 'WI-1' })
    submissionFindFirst.mockResolvedValue({ id: 'sub-1', status: 'ACCEPTED', headCommitSha: 'abc1234' })
    startReconciliation.mockResolvedValue(run('FAILED'))
    const failed = await activateReconcile(node(), instance(), 'clicker-1')

    // Both halt — but an operator must never be able to read them as the same thing.
    expect(unproven.passed).toBe(false)
    expect(failed.passed).toBe(false)
    expect(unproven.output.reconcile.status).toBe('NOT_VERIFIED')
    expect(failed.output.reconcile.status).toBe('FAILED')
    expect(unproven.output.reconcile.unproven).toBe(true)
    expect(failed.output.reconcile.unproven).toBe(false)
    expect(unprovenMutation).toBe('RECONCILE_NOT_VERIFIED')
    expect(lastMutationType()).toBe('RECONCILE_FAILED')
    expect(unprovenEvent).toBe('ReconcileNotVerified')
    expect(lastEventType()).toBe('ReconcileFailed')
    expect(unproven.output.reconcile.outcome).not.toBe(failed.output.reconcile.outcome)
  })

  it('halts legibly when no submission exists instead of crashing', async () => {
    submissionFindFirst.mockResolvedValue(null)
    const result = await activateReconcile(node(), instance(), 'clicker-1')

    expect(result.passed).toBe(false)
    expect(result.output.reconcile.status).toBe('HALTED')
    expect(result.output.reconcile.outcome).toMatch(/No implementation submission exists for WI-1/)
    expect(result.output.reconcile.outcome).toMatch(/restart this node/)
    expect(startReconciliation).not.toHaveBeenCalled()
    expect(lastMutationType()).toBe('RECONCILE_HALTED')
  })

  it('halts legibly when the run is not linked to a Work Item', async () => {
    const result = await activateReconcile(node(), instance({ context: {} }), 'clicker-1')
    expect(result.passed).toBe(false)
    expect(result.output.reconcile.status).toBe('HALTED')
    expect(result.output.reconcile.outcome).toMatch(/not linked to a Work Item/)
    expect(startReconciliation).not.toHaveBeenCalled()
  })

  it('turns a thrown service error into a halt carrying the real reason', async () => {
    startReconciliation.mockRejectedValue(new Error('The developer handoff is not published; cannot reconcile against it.'))
    const result = await activateReconcile(node(), instance(), 'clicker-1')
    expect(result.passed).toBe(false)
    expect(result.output.reconcile.status).toBe('HALTED')
    expect(result.output.reconcile.outcome).toMatch(/handoff is not published/)
  })

  it('attributes the reconciliation to the human who triggered the node', async () => {
    startReconciliation.mockResolvedValue(run('DECLARED_CONSISTENT'))
    await activateReconcile(node(), instance(), 'clicker-1')
    expect(startReconciliation).toHaveBeenCalledWith('wi-1', 'sub-1', 'clicker-1', 'DETERMINISTIC', { requireChangeManifest: true })
  })

  it('falls back to the run creator when the node fires without a triggering user', async () => {
    startReconciliation.mockResolvedValue(run('DECLARED_CONSISTENT'))
    await activateReconcile(node(), instance(), undefined)
    expect(startReconciliation).toHaveBeenCalledWith('wi-1', 'sub-1', 'creator-1', 'DETERMINISTIC', { requireChangeManifest: true })
  })

  it('halts rather than inventing a system actor when the run has none', async () => {
    const result = await activateReconcile(node(), instance({ createdById: null }), undefined)
    expect(result.passed).toBe(false)
    expect(result.output.reconcile.status).toBe('HALTED')
    expect(result.output.reconcile.outcome).toMatch(/records no actor/)
    expect(startReconciliation).not.toHaveBeenCalled()
  })

  it('passes the configured mode through and honours requireChangeManifest:false', async () => {
    startReconciliation.mockResolvedValue(run('RUNNING'))
    const result = await activateReconcile(
      node({ mode: 'DYNAMIC', requireChangeManifest: false }),
      instance(),
      'clicker-1',
    )
    expect(startReconciliation).toHaveBeenCalledWith('wi-1', 'sub-1', 'clicker-1', 'DYNAMIC', { requireChangeManifest: false })
    // A queued test job is not a verdict.
    expect(result.passed).toBe(false)
    expect(result.output.reconcile.status).toBe('AWAITING_TESTS')
    expect(lastMutationType()).toBe('RECONCILE_AWAITING_TESTS')
  })

  it('skips REJECTED submissions when picking the latest one', async () => {
    startReconciliation.mockResolvedValue(run('DECLARED_CONSISTENT'))
    await activateReconcile(node(), instance(), 'clicker-1')
    expect(submissionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ NOT: { status: 'REJECTED' } }) }),
    )
  })
})
