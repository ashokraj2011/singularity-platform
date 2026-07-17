import { describe, it, expect, vi, beforeEach } from 'vitest'

// Reconciliation is evidence-only. WorkItemFinalizer owns COMPLETED transitions; these tests
// ensure reconciliation can update evidence state without completing or reopening the item.
vi.mock('../src/lib/prisma', () => ({ prisma: {} }))
vi.mock('../src/lib/tenant-db-context', () => ({
  withTenantDbTransaction: (_p: unknown, fn: (tx: unknown) => unknown) => fn({}),
  currentTenantIdForDb: () => 'default',
}))
vi.mock('../src/lib/audit', () => ({ logEvent: vi.fn(), publishOutbox: vi.fn() }))

import { applyReconciliationCompletionGate } from '../src/modules/reconciliations/reconciliations.service'

function fakeTx() {
  const updates: any[] = []
  const events: any[] = []
  return {
    tx: {
      workItem: { update: vi.fn(async (args: any) => { updates.push(args); return {} }) },
      workItemEvent: { create: vi.fn(async (args: any) => { events.push(args.data); return {} }) },
    } as any,
    updates,
    events,
  }
}

const base = {
  workItemId: 'wi1',
  reconciliationRunId: 'run1',
  submissionId: 'sub1',
  actorId: 'user1',
  tenantId: 'default',
}

describe('applyReconciliationCompletionGate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records VERIFIED evidence without completing an IN_PROGRESS item', async () => {
    const { tx, updates, events } = fakeTx()
    const t = await applyReconciliationCompletionGate(tx, { ...base, currentStatus: 'IN_PROGRESS', runStatus: 'VERIFIED_PASS' })
    expect(t).toMatchObject({ from: 'IN_PROGRESS', to: 'VERIFIED', eventType: 'RECONCILIATION_EVIDENCE_UPDATED' })
    expect(updates[0].data).toEqual({ reconciliationState: 'VERIFIED' })
    expect(events[0].eventType).toBe('RECONCILIATION_EVIDENCE_UPDATED')
  })

  it('can record evidence on an already completed item without changing status', async () => {
    const { tx, updates } = fakeTx()
    const t = await applyReconciliationCompletionGate(tx, { ...base, currentStatus: 'COMPLETED', runStatus: 'VERIFIED_PASS' })
    expect(t).toMatchObject({ to: 'VERIFIED' })
    expect(updates[0].data).toEqual({ reconciliationState: 'VERIFIED' })
  })

  it.each(['PASSED', 'PARTIAL', 'FAILED', 'ERROR'])('does not verify on a non-dynamic (%s) run', async (runStatus) => {
    const { tx, updates } = fakeTx()
    const t = await applyReconciliationCompletionGate(tx, { ...base, currentStatus: 'IN_PROGRESS', runStatus })
    expect(t).toMatchObject({ to: 'NOT_VERIFIED' })
    expect(updates[0].data).toEqual({ reconciliationState: 'NOT_VERIFIED' })
  })

  it.each(['PASSED', 'PARTIAL', 'FAILED', 'ERROR'])('marks a completed item CONTESTED when a later run is %s', async (runStatus) => {
    const { tx, updates, events } = fakeTx()
    const t = await applyReconciliationCompletionGate(tx, { ...base, currentStatus: 'COMPLETED', runStatus })
    expect(t).toMatchObject({ from: 'COMPLETED', to: 'CONTESTED', eventType: 'RECONCILIATION_CONTESTED' })
    expect(updates[0].data).toEqual({ reconciliationState: 'CONTESTED' })
    expect(events[0].eventType).toBe('RECONCILIATION_CONTESTED')
  })

  it.each(['CANCELLED', 'ARCHIVED'])('never touches a terminal (%s) item', async (currentStatus) => {
    const { tx, updates, events } = fakeTx()
    const passed = await applyReconciliationCompletionGate(tx, { ...base, currentStatus, runStatus: 'VERIFIED_PASS' })
    const failed = await applyReconciliationCompletionGate(tx, { ...base, currentStatus, runStatus: 'FAILED' })
    expect(passed).toBeNull()
    expect(failed).toBeNull()
    expect(updates).toHaveLength(0)
    expect(events).toHaveLength(0)
  })
})
