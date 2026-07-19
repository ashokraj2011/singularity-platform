import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Synthesis Foundations — the fenced message-append core. Mocks the tenant
 * transaction (mirrors graph-traverser-tenant.test.ts): a fake `tx` serves the
 * FOR UPDATE fence read + the create/update calls, and withTenantDbTransaction just
 * runs the callback with it. Asserts gap-free seq allocation, tenant-scoped fencing,
 * and idempotent coalescing — all without a database.
 */
let currentTenant: string | undefined = 'tenant-a'

const queryRawMock = vi.fn()
const msgCreateMock = vi.fn()
const msgFindFirstMock = vi.fn()
const threadUpdateMock = vi.fn()
const wsUpdateMock = vi.fn()

const fakeTx = {
  $queryRaw: (...args: unknown[]) => queryRawMock(...args),
  workspaceMessage: { create: (a: unknown) => msgCreateMock(a), findFirst: (a: unknown) => msgFindFirstMock(a) },
  workspaceThread: { update: (a: unknown) => threadUpdateMock(a) },
  synthesisWorkspace: { update: (a: unknown) => wsUpdateMock(a) },
}

vi.mock('../src/lib/tenant-db-context', () => ({
  currentTenantIdForDb: () => currentTenant,
  withTenantDbTransaction: (_p: unknown, cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx),
}))
vi.mock('../src/config', () => ({ config: { WORKGRAPH_DEFAULT_TENANT_ID: 'default-tenant' } }))
vi.mock('../src/lib/prisma', () => ({ prisma: {} }))

import { appendMessage } from '../src/modules/synthesis/message.service'

const humanTurn = { role: 'USER' as const, authorType: 'HUMAN' as const, content: {} }

beforeEach(() => {
  currentTenant = 'tenant-a'
  queryRawMock.mockReset()
  msgCreateMock.mockReset().mockImplementation((a: { data: { seq: bigint } }) => Promise.resolve({ id: 'm1', ...a.data }))
  msgFindFirstMock.mockReset().mockResolvedValue(null)
  threadUpdateMock.mockReset().mockResolvedValue({})
  wsUpdateMock.mockReset().mockResolvedValue({})
})

describe('appendMessage — fenced, gap-free, tenant-scoped', () => {
  it('allocates headSeq+1, inserts at that seq, and advances the fence', async () => {
    queryRawMock.mockResolvedValue([{ id: 't1', headSeq: 7n, status: 'ACTIVE' }])
    const r = await appendMessage('ws1', 't1', humanTurn)
    expect(r.deduped).toBe(false)
    expect(r.message.seq).toBe(8) // shaped BigInt → Number for JSON
    expect(msgCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ seq: 8n, tenantId: 'tenant-a', workspaceId: 'ws1', threadId: 't1' }),
    }))
    expect(threadUpdateMock).toHaveBeenCalledWith({ where: { id: 't1' }, data: { headSeq: 8n } })
    expect(wsUpdateMock).toHaveBeenCalled()
  })

  it('scopes the FOR UPDATE fence read to the thread, workspace, and tenant', async () => {
    queryRawMock.mockResolvedValue([{ id: 't1', headSeq: 0n, status: 'ACTIVE' }])
    await appendMessage('ws1', 't1', humanTurn)
    const values = (queryRawMock.mock.calls[0] ?? []).slice(1) // [strings, ...interpolated]
    expect(values).toContain('t1')
    expect(values).toContain('ws1')
    expect(values).toContain('tenant-a')
  })

  it('coalesceKey makes retries idempotent — returns the prior message, no new insert', async () => {
    queryRawMock.mockResolvedValue([{ id: 't1', headSeq: 3n, status: 'ACTIVE' }])
    msgFindFirstMock.mockResolvedValue({ id: 'existing', seq: 2n })
    const r = await appendMessage('ws1', 't1', { ...humanTurn, coalesceKey: 'k1' })
    expect(r.deduped).toBe(true)
    expect(r.message.seq).toBe(2)
    expect(msgCreateMock).not.toHaveBeenCalled()
  })

  it('rejects an append to a non-ACTIVE thread', async () => {
    queryRawMock.mockResolvedValue([{ id: 't1', headSeq: 0n, status: 'CLOSED' }])
    await expect(appendMessage('ws1', 't1', humanTurn)).rejects.toThrow(/CLOSED/)
  })

  it('throws NotFound when the thread is absent or cross-tenant (fence returns no row)', async () => {
    queryRawMock.mockResolvedValue([])
    await expect(appendMessage('ws1', 'tX', humanTurn)).rejects.toThrow()
    expect(msgCreateMock).not.toHaveBeenCalled()
  })

  it('rejects a stale expectedHeadSeq', async () => {
    queryRawMock.mockResolvedValue([{ id: 't1', headSeq: 5n, status: 'ACTIVE' }])
    await expect(appendMessage('ws1', 't1', { ...humanTurn, expectedHeadSeq: 3 })).rejects.toThrow(/Stale/)
  })
})
