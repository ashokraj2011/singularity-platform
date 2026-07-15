import { describe, it, expect, vi, beforeEach } from 'vitest'

// spawnCompletionProgram is the completion fan-out: when a work item finalizes it auto-executes
// its attached Work Program (resolved item -> project), once, recording NEXT_STAGE_SPAWNED /
// NEXT_STAGE_SPAWN_FAILED. Pure unit tests: mock prisma reads + a fake transaction client so the
// real executor runs against an empty-step program (no child work items created), no DB touched.
const workItemFindUnique = vi.fn()
const eventFindFirst = vi.fn()
const specFindFirst = vi.fn()

// The fake tx serves every withTenantDbTransaction callback used by the fan-out + spawn.
const programFindFirst = vi.fn()
const runCreate = vi.fn()
const runFindUnique = vi.fn()
const eventCreate = vi.fn()
const tx = {
  workProgram: { findFirst: (...a: unknown[]) => programFindFirst(...a) },
  workProgramRun: { create: (...a: unknown[]) => runCreate(...a), findUnique: (...a: unknown[]) => runFindUnique(...a), updateMany: vi.fn() },
  workProgramRunStep: { create: vi.fn(), update: vi.fn() },
  workItemEvent: { create: (...a: unknown[]) => eventCreate(...a) },
}

vi.mock('../src/lib/prisma', () => ({
  prisma: {
    workItem: { findUnique: (...a: unknown[]) => workItemFindUnique(...a) },
    workItemEvent: { findFirst: (...a: unknown[]) => eventFindFirst(...a) },
    specificationVersion: { findFirst: (...a: unknown[]) => specFindFirst(...a) },
  },
}))
vi.mock('../src/lib/tenant-db-context', () => ({
  withTenantDbTransaction: (_p: unknown, fn: (t: unknown) => unknown) => fn(tx),
  currentTenantIdForDb: () => 'default',
}))
vi.mock('../src/lib/audit', () => ({ logEvent: vi.fn(), publishOutbox: vi.fn() }))
vi.mock('../src/modules/work-items/work-items.service', () => ({ createWorkItem: vi.fn() }))
vi.mock('../src/modules/work-items/work-item-routing.service', () => ({ routeWorkItem: vi.fn() }))
vi.mock('../src/modules/work-items/work-item-dependencies.service', () => ({ createWorkItemDependency: vi.fn() }))

import { spawnCompletionProgram } from '../src/modules/work-program/work-programs.service'
import { NotFoundError } from '../src/lib/errors'

const args = { workItemId: 'wi1', actorId: 'user1' }
const eventTypes = () => eventCreate.mock.calls.map((c: any) => c[0].data.eventType)

describe('spawnCompletionProgram', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventFindFirst.mockResolvedValue(null)
    specFindFirst.mockResolvedValue({ id: 'spec1', version: 3, contentHash: 'sha256:abc' })
    runCreate.mockResolvedValue({ id: 'run1' })
    runFindUnique.mockResolvedValue({ id: 'run1', steps: [] })
    eventCreate.mockResolvedValue({})
  })

  it('throws NotFound when the work item is missing', async () => {
    workItemFindUnique.mockResolvedValue(null)
    await expect(spawnCompletionProgram(args)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('no-ops when neither item nor project has a program', async () => {
    workItemFindUnique.mockResolvedValue({ id: 'wi1', workCode: 'WI-1', title: 'T', projectId: null, tenantId: 'default', completionProgramId: null, project: null })
    const r = await spawnCompletionProgram(args)
    expect(r).toEqual({ spawned: false, reason: 'no-program' })
    expect(programFindFirst).not.toHaveBeenCalled()
  })

  it('is idempotent — skips when a NEXT_STAGE_SPAWNED event already exists', async () => {
    workItemFindUnique.mockResolvedValue({ id: 'wi1', workCode: 'WI-1', title: 'T', projectId: null, tenantId: 'default', completionProgramId: 'prog1', project: null })
    eventFindFirst.mockResolvedValue({ id: 'ev1' })
    const r = await spawnCompletionProgram(args)
    expect(r).toEqual({ spawned: false, reason: 'already-spawned', programId: 'prog1' })
    expect(programFindFirst).not.toHaveBeenCalled()
  })

  it('executes the item-level program (preferred over project) and records NEXT_STAGE_SPAWNED', async () => {
    workItemFindUnique.mockResolvedValue({ id: 'wi1', workCode: 'WI-1', title: 'Ship it', projectId: 'p1', tenantId: 'default', completionProgramId: 'prog1', project: { code: 'PRJ', name: 'Payments', completionProgramId: 'projprog' } })
    programFindFirst.mockResolvedValue({ id: 'prog1', status: 'ACTIVE', capabilityId: null, steps: [] })
    const r = await spawnCompletionProgram(args)
    expect(r).toMatchObject({ spawned: true, programId: 'prog1', runId: 'run1', workItems: [], warnings: [] })
    expect(programFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'prog1', tenantId: 'default' } }))
    expect(eventTypes()).toContain('NEXT_STAGE_SPAWNED')
  })

  it('falls back to the project program when the item has none', async () => {
    workItemFindUnique.mockResolvedValue({ id: 'wi1', workCode: 'WI-1', title: 'T', projectId: 'p1', tenantId: 'default', completionProgramId: null, project: { code: 'PRJ', name: 'Payments', completionProgramId: 'projprog' } })
    programFindFirst.mockResolvedValue({ id: 'projprog', status: 'ACTIVE', capabilityId: null, steps: [] })
    const r = await spawnCompletionProgram(args)
    expect(r).toMatchObject({ spawned: true, programId: 'projprog' })
    expect(programFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'projprog', tenantId: 'default' } }))
  })

  it('records NEXT_STAGE_SPAWN_FAILED and does not throw when the program is not ACTIVE', async () => {
    workItemFindUnique.mockResolvedValue({ id: 'wi1', workCode: 'WI-1', title: 'T', projectId: null, tenantId: 'default', completionProgramId: 'prog1', project: null })
    programFindFirst.mockResolvedValue({ id: 'prog1', status: 'DRAFT', capabilityId: null, steps: [] })
    const r = await spawnCompletionProgram(args)
    expect(r).toMatchObject({ spawned: false, reason: 'error', programId: 'prog1' })
    expect(r).toHaveProperty('error')
    expect(eventTypes()).toContain('NEXT_STAGE_SPAWN_FAILED')
  })
})
