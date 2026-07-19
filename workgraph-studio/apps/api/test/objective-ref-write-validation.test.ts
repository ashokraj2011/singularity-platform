/**
 * Contract: a requirement cannot be saved referencing an objective that does not
 * exist on this project.
 *
 * detectObjectiveCoverage already errors on dangling refs — but at READ time, so
 * a bad package saved happily and nothing objected until someone opened coverage
 * or attempted a lock. By then the edit that caused it was long gone, and the
 * failure presented as a lock problem rather than a bad reference.
 *
 * These pin the write-time gate and, just as importantly, that it did NOT become
 * stricter than intended: existing packages must stay readable, and requirements
 * with no refs at all must stay savable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const findMany = vi.fn()

vi.mock('../src/lib/prisma', () => ({
  prisma: {
    businessObjective: { findMany: (...args: unknown[]) => findMany(...args) },
    projectSpecification: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('../src/lib/tenant-db-context', () => ({ currentTenantIdForDb: () => 'default' }))
vi.mock('../src/lib/audit', () => ({ logEvent: vi.fn() }))
vi.mock('../src/modules/studio/studio-projects.service', () => ({ getProject: vi.fn() }))

const OBJ_A = '11111111-1111-4111-8111-111111111111'
const OBJ_B = '22222222-2222-4222-8222-222222222222'
const MISSING = '33333333-3333-4333-8333-333333333333'

function requirement(id: string, objectiveRefs: string[]) {
  return { id, statement: `${id} statement`, priority: 'MUST', acceptanceCriteria: [], claimRefs: [], decisionRefs: [], objectiveRefs }
}

beforeEach(() => {
  findMany.mockReset()
})

describe('objective reference write validation', () => {
  it('rejects a requirement pointing at an objective that does not exist', async () => {
    findMany.mockResolvedValue([{ id: OBJ_A }])
    const { patchProjectSpecSection } = await import('../src/modules/studio/studio-spec.service')

    await expect(patchProjectSpecSection('proj-1', {
      section: 'requirements',
      value: [requirement('REQ-1', [OBJ_A]), requirement('REQ-2', [MISSING])],
      expectedRevision: 1,
    }, 'user-1')).rejects.toThrow(/do not resolve/)
  })

  it('names the requirement, not just the objective id', async () => {
    // "objective X is unknown" is not actionable when 40 requirements save at once.
    findMany.mockResolvedValue([])
    const { patchProjectSpecSection } = await import('../src/modules/studio/studio-spec.service')

    await expect(patchProjectSpecSection('proj-1', {
      section: 'requirements',
      value: [requirement('REQ-7', [MISSING])],
      expectedRevision: 1,
    }, 'user-1')).rejects.toThrow(/REQ-7 -> 33333333/)
  })

  it('accepts refs that resolve, including several across requirements', async () => {
    findMany.mockResolvedValue([{ id: OBJ_A }, { id: OBJ_B }])
    const { patchProjectSpecSection } = await import('../src/modules/studio/studio-spec.service')

    // Passing validation means it proceeds to the revision check; reaching a
    // DIFFERENT failure proves the objective gate let it through.
    await expect(patchProjectSpecSection('proj-1', {
      section: 'requirements',
      value: [requirement('REQ-1', [OBJ_A]), requirement('REQ-2', [OBJ_A, OBJ_B])],
      expectedRevision: 999,
    }, 'user-1')).rejects.not.toThrow(/do not resolve/)
  })

  it('does not query at all when nothing references an objective', async () => {
    // The common case must not pay for a lookup it cannot need.
    const { patchProjectSpecSection } = await import('../src/modules/studio/studio-spec.service')
    await patchProjectSpecSection('proj-1', {
      section: 'requirements',
      value: [requirement('REQ-1', [])],
      expectedRevision: 999,
    }, 'user-1').catch(() => undefined)
    expect(findMany).not.toHaveBeenCalled()
  })

  it('only accepts objectives visible to THIS project', async () => {
    findMany.mockResolvedValue([])
    const { patchProjectSpecSection } = await import('../src/modules/studio/studio-spec.service')
    await patchProjectSpecSection('proj-1', {
      section: 'requirements',
      value: [requirement('REQ-1', [OBJ_A])],
      expectedRevision: 1,
    }, 'user-1').catch(() => undefined)

    const where = findMany.mock.calls[0]?.[0]?.where
    expect(where?.OR).toEqual([
      { studioProjectId: 'proj-1' },
      { projectLinks: { some: { projectId: 'proj-1' } } },
    ])
  })

  it('leaves other sections untouched', async () => {
    // Only requirements carry objectiveRefs; analysis and decisions must not pay
    // a lookup or gain a new failure mode.
    const { patchProjectSpecSection } = await import('../src/modules/studio/studio-spec.service')
    await patchProjectSpecSection('proj-1', {
      section: 'decisions',
      value: [],
      expectedRevision: 999,
    }, 'user-1').catch(() => undefined)
    expect(findMany).not.toHaveBeenCalled()
  })
})
