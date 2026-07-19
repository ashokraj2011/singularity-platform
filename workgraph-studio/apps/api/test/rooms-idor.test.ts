import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * R0 (Synthesis) — rooms IDOR fix. The direct-by-id reads getRoom/getClaim/
 * estimateClaim/getRegistryClaims previously did unfiltered findUnique/findMany and
 * leaked cross-tenant. They now scope to a CONCRETE tenant (currentTenantIdForDb ??
 * default) — the crux is the filter is NEVER `undefined`, which Prisma treats as
 * "no filter". Mocking style mirrors test/graph-traverser-tenant.test.ts.
 */

// Ambient tenant the service reads (mutated per test); read lazily inside the mock.
let currentTenant: string | undefined
vi.mock('../src/lib/tenant-db-context', () => ({
  currentTenantIdForDb: () => currentTenant,
}))
vi.mock('../src/config', () => ({ config: { WORKGRAPH_DEFAULT_TENANT_ID: 'default-tenant' } }))
vi.mock('../src/lib/audit', () => ({
  logEvent: vi.fn().mockResolvedValue('event-id'),
  publishOutbox: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/modules/studio/studio-projects.service', () => ({
  getProject: vi.fn().mockResolvedValue({ id: 'proj-1' }),
}))

const roomFindFirst = vi.fn()
const claimFindFirst = vi.fn()
const claimFindMany = vi.fn()
vi.mock('../src/lib/prisma', () => ({
  prisma: {
    room: { findFirst: (args: unknown) => roomFindFirst(args) },
    claim: { findFirst: (args: unknown) => claimFindFirst(args), findMany: (args: unknown) => claimFindMany(args) },
    estimate: { findMany: vi.fn().mockResolvedValue([]) },
    evidence: { findMany: vi.fn().mockResolvedValue([]) },
  },
}))

import { getRoom, getClaim, getRegistryClaims } from '../src/modules/rooms/rooms.service'

const whereOf = (mock: ReturnType<typeof vi.fn>): Record<string, unknown> => {
  const args = mock.mock.calls[0]?.[0] as { where?: Record<string, unknown> } | undefined
  return args?.where ?? {}
}

const fakeClaim = {
  id: 'claim-1', alpha: 1, beta: 1, estimates: [], projectId: 'p', roomId: null,
  statement: 's', riskiestAssumption: null, claimType: 'TECHNICAL', contextScope: 'default',
  entityKind: null, entityId: null, capabilityId: null, status: 'OPEN', stewardId: 'u',
  provenance: {}, createdAt: new Date(), updatedAt: new Date(),
}

beforeEach(() => {
  currentTenant = undefined
  roomFindFirst.mockReset().mockResolvedValue({ id: 'room-1', claims: [] })
  claimFindFirst.mockReset().mockResolvedValue(fakeClaim)
  claimFindMany.mockReset().mockResolvedValue([])
})

describe('rooms IDOR fix — direct-by-id reads are tenant-scoped', () => {
  it('getRoom filters by the ambient tenant', async () => {
    currentTenant = 'tenant-a'
    await getRoom('room-1')
    expect(whereOf(roomFindFirst)).toMatchObject({ id: 'room-1', tenantId: 'tenant-a' })
  })

  it('getClaim filters by the ambient tenant', async () => {
    currentTenant = 'tenant-a'
    await getClaim('claim-1')
    expect(whereOf(claimFindFirst)).toMatchObject({ id: 'claim-1', tenantId: 'tenant-a' })
  })

  it('getRegistryClaims filters by the ambient tenant', async () => {
    currentTenant = 'tenant-a'
    await getRegistryClaims({})
    expect(whereOf(claimFindMany)).toMatchObject({ tenantId: 'tenant-a' })
  })

  it('falls back to a CONCRETE default tenant when context is missing — never an undefined (unscoped) filter', async () => {
    currentTenant = undefined
    await getRoom('room-1')
    await getClaim('claim-1')
    await getRegistryClaims({})
    for (const m of [roomFindFirst, claimFindFirst, claimFindMany]) {
      const t = whereOf(m).tenantId
      expect(t).toBe('default-tenant')
      expect(t).not.toBeUndefined()
    }
  })
})
