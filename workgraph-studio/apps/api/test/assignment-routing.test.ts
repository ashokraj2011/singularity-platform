import { describe, expect, it } from 'vitest'
import {
  assertAssignmentResolved,
  resolveAssignmentRouting,
  resolveAssignmentValue,
} from '../src/modules/task/lib/assignment'

const context = {
  _vars: {
    approverId: '10000000-0000-0000-0000-000000000001',
    requiredRole: 'reviewer',
    region: 'eu',
  },
  _globals: { defaultRole: 'owner' },
  _params: { fallbackRole: 'qa' },
  event: { approverId: '10000000-0000-0000-0000-000000000002' },
  output: { requesterId: '10000000-0000-0000-0000-000000000003' },
}

describe('Human Task assignment runtime bindings', () => {
  it('resolves explicit instance aliases and composed values', () => {
    expect(resolveAssignmentValue('{{instance.vars.requiredRole}}', context)).toBe('reviewer')
    expect(resolveAssignmentValue('{{instance.params.fallbackRole}}', context)).toBe('qa')
    expect(resolveAssignmentValue('{{event.approverId}}', context)).toBe('10000000-0000-0000-0000-000000000002')
    expect(resolveAssignmentValue('reviewer-{{vars.region}}', context)).toBe('reviewer-eu')
  })

  it('infers role routing when a role is configured without a separate mode', () => {
    const routing = resolveAssignmentRouting({ roleKey: '{{instance.vars.requiredRole}}' }, 'capability-1', context)
    expect(routing.mode).toBe('ROLE_BASED')
    expect(routing.roleKey).toBe('reviewer')
    expect(routing.capabilityId).toBe('capability-1')
  })

  it('fails closed when a configured runtime selector is missing', () => {
    const routing = resolveAssignmentRouting({
      assignmentMode: 'DIRECT_USER',
      assignedToId: '{{instance.vars.missingApprover}}',
    }, 'capability-1', context)

    expect(() => assertAssignmentResolved({
      assignmentMode: 'DIRECT_USER',
      assignedToId: '{{instance.vars.missingApprover}}',
    }, routing, 'Human task "Review"')).toThrow(/could not be resolved/)
  })
})
