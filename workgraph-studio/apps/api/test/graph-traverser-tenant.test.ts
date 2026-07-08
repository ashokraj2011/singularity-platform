import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WorkflowEdge, WorkflowInstance, WorkflowNode } from '@prisma/client'

// RLS prep (engine-wide tenant-tx threading, slice 1) — GraphTraverser's
// resolveNextNodes/isComplete derive tenantId from the `instance` they already
// receive and route every DB call through withTenantDbTransaction. Mirrors the
// mocking style in test/tenant-db-context.test.ts: a fake `tx` records
// `$executeRaw` calls and serves stubbed model methods; `prisma.$transaction`
// just invokes the callback with that `tx` so withTenantDbTransaction's own
// (already-tested) set_config logic runs for real against our fake.

// withTenantDbTransaction itself issues a `select set_config(...)` via
// $executeRaw before running the callback, so the SAME fake `tx.$executeRaw`
// sees BOTH that internal call AND any raw SQL the application code (here,
// the PARALLEL_JOIN counter UPDATE) issues inside the callback. Record every
// call, then filter by SQL text to tell them apart.
const allExecuteRawCalls: { sql: string; values: unknown[] }[] = []
const findUniqueMock = vi.fn()
const countMock = vi.fn()
const updateNodeMock = vi.fn()
const updateInstanceMock = vi.fn()
const createMutationMock = vi.fn()
const executeRawMock = vi.fn().mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
  allExecuteRawCalls.push({ sql: String(strings[0]), values })
  return Promise.resolve(1)
})
function setConfigCallsFor(tenantId: string) {
  return allExecuteRawCalls.filter((c) => c.sql.startsWith('select set_config') && c.values[0] === tenantId)
}

const fakeTx = {
  $executeRaw: executeRawMock,
  workflowNode: {
    findUnique: findUniqueMock,
    count: countMock,
    update: updateNodeMock,
  },
  workflowInstance: {
    update: updateInstanceMock,
  },
  workflowMutation: {
    create: createMutationMock,
  },
}

vi.mock('../src/lib/prisma', () => ({
  prisma: {
    $transaction: (callback: (tx: typeof fakeTx) => Promise<unknown>) => callback(fakeTx),
  },
}))

vi.mock('../src/lib/audit', () => ({
  logEvent: vi.fn().mockResolvedValue('event-id'),
}))

import { resolveNextNodes, isComplete } from '../src/modules/workflow/runtime/GraphTraverser'

function makeInstance(tenantId: string | null): WorkflowInstance {
  return { id: 'inst-1', tenantId } as unknown as WorkflowInstance
}

function makeEdge(overrides: Partial<WorkflowEdge> = {}): WorkflowEdge {
  return {
    id: 'edge-1',
    sourceNodeId: 'node-completed',
    targetNodeId: 'node-next',
    edgeType: 'NORMAL',
    condition: {},
    ...overrides,
  } as unknown as WorkflowEdge
}

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id: 'node-completed', nodeType: 'TOOL_REQUEST', config: {}, ...overrides } as unknown as WorkflowNode
}

beforeEach(() => {
  allExecuteRawCalls.length = 0
  findUniqueMock.mockReset()
  countMock.mockReset()
  updateNodeMock.mockReset()
  updateInstanceMock.mockReset()
  createMutationMock.mockReset()
  executeRawMock.mockClear()
})

describe('GraphTraverser tenant scoping (RLS prep)', () => {
  it('resolveNextNodes sets app.tenant_id from instance.tenantId before hydrating the next node', async () => {
    findUniqueMock.mockResolvedValue({ id: 'node-next', config: {} })
    const instance = makeInstance('tenant-abc')

    const next = await resolveNextNodes(instance, makeNode(), [makeEdge()], {})

    expect(next).toEqual([{ id: 'node-next', config: {} }])
    expect(findUniqueMock).toHaveBeenCalledWith({ where: { id: 'node-next' } })
    expect(setConfigCallsFor('tenant-abc')).toHaveLength(1)
  })

  it('resolveNextNodes scopes the PARALLEL_JOIN raw UPDATE + re-fetch to the instance tenant', async () => {
    findUniqueMock
      .mockResolvedValueOnce({ id: 'node-join', config: { completed_joins: 0 } }) // initial read
      .mockResolvedValueOnce({ id: 'node-join', config: { completed_joins: 1, expected_joins: 1 } }) // post-update re-fetch
    const instance = makeInstance('tenant-join')
    const joinEdge = makeEdge({ edgeType: 'PARALLEL_JOIN', targetNodeId: 'node-join' })

    const next = await resolveNextNodes(instance, makeNode(), [joinEdge], {})

    expect(next).toEqual([{ id: 'node-join', config: { completed_joins: 1, expected_joins: 1 } }])
    // The initial read and the UPDATE+re-fetch are two separate
    // withTenantDbTransaction calls (one per existing transaction boundary —
    // this slice adds tenant scope, it doesn't change transaction grouping),
    // so two set_config calls for this tenant, plus the join counter's own
    // explicit raw UPDATE.
    expect(setConfigCallsFor('tenant-join')).toHaveLength(2)
    const updateCalls = allExecuteRawCalls.filter((c) => c.sql.includes('UPDATE workflow_nodes'))
    expect(updateCalls).toHaveLength(1)
  })

  it('isComplete scopes the active/pending count to the instance tenant', async () => {
    countMock.mockResolvedValue(0)
    const instance = makeInstance('tenant-xyz')

    const complete = await isComplete(instance)

    expect(complete).toBe(true)
    expect(countMock).toHaveBeenCalledWith({
      where: { instanceId: 'inst-1', status: { in: ['PENDING', 'ACTIVE'] } },
    })
    expect(setConfigCallsFor('tenant-xyz')).toHaveLength(1)
  })

  it('blocks and pauses a decision gate when no branch matches and no default exists', async () => {
    const instance = makeInstance('tenant-stall')
    const completed = makeNode({ nodeType: 'DECISION_GATE', label: 'Route by risk' })
    const edge = makeEdge({
      edgeType: 'CONDITIONAL',
      condition: {
        conditions: [{ left: 'risk', op: '==', right: 'low' }],
      },
    })

    const next = await resolveNextNodes(instance, completed, [edge], { risk: 'high' })

    expect(next).toEqual([])
    expect(updateNodeMock).toHaveBeenCalledWith({
      where: { id: 'node-completed' },
      data: { status: 'BLOCKED', completedAt: expect.any(Date) },
    })
    expect(updateInstanceMock).toHaveBeenCalledWith({
      where: { id: 'inst-1' },
      data: expect.objectContaining({
        status: 'PAUSED',
        context: expect.objectContaining({
          risk: 'high',
          _blockedByPathStall: expect.objectContaining({
            code: 'PATH_STALL',
            sourceNodeLabel: 'Route by risk',
            outgoingEdgeIds: ['edge-1'],
          }),
        }),
      }),
    })
    expect(createMutationMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        instanceId: 'inst-1',
        nodeId: 'node-completed',
        mutationType: 'PATH_STALL_BLOCKED',
      }),
    })
    expect(setConfigCallsFor('tenant-stall')).toHaveLength(1)
  })

  it('a tenant-less instance (tenantId: null) does not set app.tenant_id — unchanged today, until later slices source a tenant', async () => {
    countMock.mockResolvedValue(0)
    const instance = makeInstance(null)

    await isComplete(instance)

    expect(allExecuteRawCalls).toEqual([])
  })
})
