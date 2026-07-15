import { describe, it, expect, vi, beforeEach } from 'vitest'

// getInheritedProjectSpec bridges a work item to its parent Specification Project's shared
// baseline. Mock the DB read + the project-spec service so this stays a pure unit test.
const findUniqueMock = vi.fn()
vi.mock('../src/lib/prisma', () => ({
  prisma: { workItem: { findUnique: (...args: unknown[]) => findUniqueMock(...args) } },
}))

const getProjectSpecMock = vi.fn()
vi.mock('../src/modules/studio/studio-spec.service', () => ({
  getProjectSpec: (...args: unknown[]) => getProjectSpecMock(...args),
}))

import { getInheritedProjectSpec } from '../src/modules/specifications/specifications.service'
import { NotFoundError } from '../src/lib/errors'

describe('getInheritedProjectSpec', () => {
  beforeEach(() => {
    findUniqueMock.mockReset()
    getProjectSpecMock.mockReset()
  })

  it('throws NotFound when the work item does not exist', async () => {
    findUniqueMock.mockResolvedValue(null)
    await expect(getInheritedProjectSpec('missing')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('returns null project/spec for a standalone (unattached) work item', async () => {
    findUniqueMock.mockResolvedValue({ id: 'wi1', projectId: null, project: null })
    const result = await getInheritedProjectSpec('wi1')
    expect(result).toEqual({ project: null, spec: null })
    expect(getProjectSpecMock).not.toHaveBeenCalled()
  })

  it('returns the parent project baseline for an attached work item', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'wi1',
      projectId: 'p1',
      project: { id: 'p1', code: 'PRJ-ABCDE', name: 'Payments' },
    })
    const updatedAt = new Date('2026-01-01T00:00:00Z')
    getProjectSpecMock.mockResolvedValue({
      projectId: 'p1',
      revision: 3,
      package: { analysis: { problem: 'p' }, requirements: [], decisions: [] },
      updatedAt,
    })
    const result = await getInheritedProjectSpec('wi1')
    expect(getProjectSpecMock).toHaveBeenCalledWith('p1')
    expect(result.project).toEqual({ id: 'p1', code: 'PRJ-ABCDE', name: 'Payments' })
    expect(result.spec).toEqual({
      revision: 3,
      package: { analysis: { problem: 'p' }, requirements: [], decisions: [] },
      updatedAt,
    })
  })
})
