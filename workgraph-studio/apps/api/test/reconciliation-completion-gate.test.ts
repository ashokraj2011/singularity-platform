import { describe, it, expect, vi, beforeEach } from 'vitest'

// applyReconciliationCompletionGate is the finalization gate: a PASSED reconciliation run
// auto-completes the work item; a non-PASSED run reopens a previously completed one. Terminal
// items (CANCELLED/ARCHIVED) are never touched. These are pure unit tests driving a fake
// transaction client, so no DB/Prisma is required. Mock the prisma + audit deps the module
// imports at load time.
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

  it('auto-completes an IN_PROGRESS item when the run PASSED', async () => {
    const { tx, updates, events } = fakeTx()
    const t = await applyReconciliationCompletionGate(tx, { ...base, currentStatus: 'IN_PROGRESS', runStatus: 'PASSED' })
    expect(t).toEqual({ from: 'IN_PROGRESS', to: 'COMPLETED', eventType: 'WORK_ITEM_COMPLETED' })
    expect(updates[0].data.status).toBe('COMPLETED')
    expect(events[0].eventType).toBe('WORK_ITEM_COMPLETED')
  })

  it('is idempotent — already COMPLETED + PASSED does nothing', async () => {
    const { tx, updates } = fakeTx()
    const t = await applyReconciliationCompletionGate(tx, { ...base, currentStatus: 'COMPLETED', runStatus: 'PASSED' })
    expect(t).toBeNull()
    expect(updates).toHaveLength(0)
  })

  it.each(['PARTIAL', 'FAILED', 'ERROR'])('does not complete on a non-PASSED (%s) run', async (runStatus) => {
    const { tx, updates } = fakeTx()
    const t = await applyReconciliationCompletionGate(tx, { ...base, currentStatus: 'IN_PROGRESS', runStatus })
    expect(t).toBeNull()
    expect(updates).toHaveLength(0)
  })

  it.each(['PARTIAL', 'FAILED', 'ERROR'])('reopens a COMPLETED item when a later run is %s', async (runStatus) => {
    const { tx, updates, events } = fakeTx()
    const t = await applyReconciliationCompletionGate(tx, { ...base, currentStatus: 'COMPLETED', runStatus })
    expect(t).toEqual({ from: 'COMPLETED', to: 'IN_PROGRESS', eventType: 'WORK_ITEM_REOPENED' })
    expect(updates[0].data.status).toBe('IN_PROGRESS')
    expect(events[0].eventType).toBe('WORK_ITEM_REOPENED')
  })

  it.each(['CANCELLED', 'ARCHIVED'])('never touches a terminal (%s) item', async (currentStatus) => {
    const { tx, updates, events } = fakeTx()
    const passed = await applyReconciliationCompletionGate(tx, { ...base, currentStatus, runStatus: 'PASSED' })
    const failed = await applyReconciliationCompletionGate(tx, { ...base, currentStatus, runStatus: 'FAILED' })
    expect(passed).toBeNull()
    expect(failed).toBeNull()
    expect(updates).toHaveLength(0)
    expect(events).toHaveLength(0)
  })
})
