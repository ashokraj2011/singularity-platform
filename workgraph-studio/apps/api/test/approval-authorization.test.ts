import { describe, expect, it } from 'vitest'
import {
  evaluateLocalApprovalRouting,
  type ApprovalRouting,
} from '../src/lib/permissions/approval'

const context = {
  userId: 'user-1',
  iamUserId: null,
  teamIds: ['team-1'],
  skillKeys: ['reviewer'],
  source: 'local' as const,
}

const base: ApprovalRouting = {
  assignedToId: 'user-1',
  assignmentMode: 'DIRECT_USER',
  teamId: 'team-1',
  skillKey: 'reviewer',
  capabilityId: 'capability-1',
  dueAt: new Date('2099-01-01T00:00:00.000Z'),
}

describe('human approval authorization', () => {
  it('allows an explicitly assigned user with an approval permission', () => {
    const result = evaluateLocalApprovalRouting({
      userId: 'user-1',
      routing: base,
      context,
      permissionKeys: ['workflow:approve'],
      permissionKey: 'workflow:approve',
    })
    expect(result).toMatchObject({ allowed: true, source: 'local' })
  })

  it('denies a user who is not the explicit assignee', () => {
    const result = evaluateLocalApprovalRouting({
      userId: 'user-2',
      routing: base,
      context: { ...context, userId: 'user-2' },
      permissionKeys: ['workflow:approve'],
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('assigned')
  })

  it('denies a cross-team approval even when the user has the permission', () => {
    const result = evaluateLocalApprovalRouting({
      userId: 'user-1',
      routing: { ...base, assignedToId: null, teamId: 'team-2' },
      context,
      permissionKeys: ['workflow:approve'],
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('team')
  })

  it('denies an expired approval', () => {
    const result = evaluateLocalApprovalRouting({
      userId: 'user-1',
      routing: { ...base, dueAt: new Date('2020-01-01T00:00:00.000Z') },
      context,
      permissionKeys: ['workflow:approve'],
      now: new Date('2021-01-01T00:00:00.000Z'),
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('expired')
  })

  it('denies a permission or skill mismatch', () => {
    const result = evaluateLocalApprovalRouting({
      userId: 'user-1',
      routing: { ...base, assignedToId: null },
      context: { ...context, skillKeys: ['developer'] },
      permissionKeys: ['workflow:view'],
      permissionKey: 'workflow:approve',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('skill')
  })
})
