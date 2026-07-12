import { describe, expect, it } from 'vitest'
import {
  evaluateLocalApprovalRouting,
  validateApprovalRouting,
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
      routing: { ...base, assignmentMode: 'TEAM_QUEUE', assignedToId: null, teamId: 'team-2', skillKey: null, capabilityId: null },
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
      routing: { ...base, assignmentMode: 'SKILL_BASED', assignedToId: null, teamId: null, skillKey: 'reviewer', capabilityId: null },
      context: { ...context, skillKeys: ['developer'] },
      permissionKeys: ['workflow:view'],
      permissionKey: 'workflow:approve',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('skill')
  })

  it('allows a platform-admin permission to override assignment routing', () => {
    const result = evaluateLocalApprovalRouting({
      userId: 'user-2',
      routing: { ...base, assignedToId: 'user-1', teamId: 'team-2', skillKey: 'security-review' },
      context: { ...context, userId: 'user-2', teamIds: [], skillKeys: [] },
      permissionKeys: ['platform:all'],
    })
    expect(result).toMatchObject({ allowed: true, isAdmin: true })
  })

  it('requires the configured role for role-based approvals', () => {
    const allowed = evaluateLocalApprovalRouting({
      userId: 'user-1',
      routing: { ...base, assignmentMode: 'ROLE_BASED', assignedToId: null, teamId: null, skillKey: null, roleKey: 'release-manager' },
      context: { ...context, roleKeys: ['release-manager'] },
      permissionKeys: ['workflow:approve'],
    })
    const denied = evaluateLocalApprovalRouting({
      userId: 'user-1',
      routing: { ...base, assignmentMode: 'ROLE_BASED', assignedToId: null, teamId: null, skillKey: null, roleKey: 'security-reviewer' },
      context: { ...context, roleKeys: ['release-manager'] },
      permissionKeys: ['workflow:approve'],
    })
    expect(allowed.allowed).toBe(true)
    expect(denied.reason).toContain('role')
  })

  it('fails closed when a role-based approval has no role selector', () => {
    expect(() => validateApprovalRouting({
      assignmentMode: 'ROLE_BASED',
      capabilityId: 'capability-1',
    })).toThrow('roleKey')
    const result = evaluateLocalApprovalRouting({
      userId: 'user-1',
      routing: { assignmentMode: 'ROLE_BASED', capabilityId: 'capability-1' },
      context: { ...context, roleKeys: ['release-manager'] },
      permissionKeys: ['workflow:approve'],
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('roleKey')
  })

  it('fails closed when a skill-based approval has no skill selector', () => {
    expect(() => validateApprovalRouting({ assignmentMode: 'SKILL_BASED' })).toThrow('skillKey')
  })

  it('matches skill routing case-insensitively across id/name representations', () => {
    const result = evaluateLocalApprovalRouting({
      userId: 'user-1',
      routing: { assignmentMode: 'SKILL_BASED', skillKey: 'REVIEWER' },
      context,
      permissionKeys: ['workflow:approve'],
    })
    expect(result.allowed).toBe(true)
  })
})
