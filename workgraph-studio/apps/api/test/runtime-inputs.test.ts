import { describe, expect, it } from 'vitest'
import { collectRuntimeInputRequirements, missingRuntimeInputs } from '../src/modules/workflow/lib/runtime-inputs'

describe('workflow runtime input contract', () => {
  it('deduplicates values while retaining every node use', () => {
    const contract = collectRuntimeInputRequirements([
      {
        id: 'node-a',
        label: 'Design review',
        nodeType: 'HUMAN_TASK',
        config: { standard: { role: '{{instance.vars.reviewerRole}}' } },
      },
      {
        id: 'node-b',
        label: 'Approval',
        nodeType: 'APPROVAL',
        config: { assignment: { roleKey: '{{vars.reviewerRole}}', assignedToId: '{{vars.approverId}}' } },
      },
    ], [])

    const role = contract.inputs.find(input => input.key === 'reviewerRole')
    expect(role?.scope).toBe('vars')
    expect(role?.kind).toBe('role')
    expect(role?.nodes.map(node => node.nodeLabel)).toEqual(['Design review', 'Approval'])
    expect(contract.inputs.some(input => input.key === 'approverId')).toBe(true)
  })

  it('keeps output references runtime-only and honors variable defaults', () => {
    const contract = collectRuntimeInputRequirements([
      {
        id: 'node-a',
        label: 'Check result',
        nodeType: 'GOVERNANCE_GATE',
        config: { rule: '{{output.designApproved}}', note: '{{vars.story}}' },
      },
    ], [{ key: 'story', defaultValue: 'sample story', type: 'STRING' }])

    expect(contract.inputs.find(input => input.key === 'story')?.required).toBe(false)
    expect(contract.inputs.some(input => input.key === 'designApproved')).toBe(false)
    expect(contract.references.find(reference => reference.key === 'designApproved')?.runtimeOnly).toBe(true)
  })

  it('reports only missing launch values', () => {
    const contract = collectRuntimeInputRequirements([
      { id: 'node-a', label: 'Review', nodeType: 'HUMAN_TASK', config: { role: '{{vars.role}}', user: '{{vars.userId}}' } },
    ])
    expect(missingRuntimeInputs(contract.inputs, { vars: { role: 'reviewer' } }).map(input => input.key)).toEqual(['userId'])
    expect(missingRuntimeInputs(contract.inputs, { vars: { role: 'reviewer', userId: 'u-1' } })).toEqual([])
  })
})
