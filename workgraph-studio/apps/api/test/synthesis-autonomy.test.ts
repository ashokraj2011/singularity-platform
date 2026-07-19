import { describe, expect, it } from 'vitest'
import { dispositionFor, isProhibitedAutonomous } from '../src/modules/synthesis/autonomy'
import { effectiveTools, toolAllowed } from '../src/modules/synthesis/permission-inheritance'

/**
 * Synthesis Agents — the safety core. The autonomy ladder never auto-applies (material
 * change caps at PROPOSE), always blocks the prohibited-action deny-list, and permission
 * inheritance is a strict intersection.
 */
describe('autonomy ladder', () => {
  it('answers when the turn produces no material change', () => {
    expect(dispositionFor('L2_PROPOSE', false, [])).toEqual({ kind: 'ANSWER' })
  })
  it('caps material change at PROPOSE for L2+ — never auto-applies', () => {
    expect(dispositionFor('L2_PROPOSE', true, ['EDIT_DOC_BLOCK'])).toEqual({ kind: 'PROPOSE' })
    expect(dispositionFor('L4_SCHEDULED', true, ['EDIT_DOC_BLOCK'])).toEqual({ kind: 'PROPOSE' })
  })
  it('blocks material change at L0 and only drafts at L1', () => {
    expect(dispositionFor('L0_ANSWER', true, ['EDIT_DOC_BLOCK']).kind).toBe('BLOCKED')
    expect(dispositionFor('L1_DRAFT', true, ['EDIT_DOC_BLOCK'])).toEqual({ kind: 'DRAFT' })
  })
  it('blocks a prohibited action even at a high ceiling', () => {
    const d = dispositionFor('L4_SCHEDULED', true, ['EDIT_DOC_BLOCK', 'APPROVE_SPEC'])
    expect(d.kind).toBe('BLOCKED')
    expect(d).toMatchObject({ reason: expect.stringContaining('APPROVE_SPEC') })
  })
  it('covers the spec\'s full prohibited-action deny-list', () => {
    for (const a of ['ACCEPT_DECISION', 'APPROVE_SPEC', 'CHANGE_BUDGET', 'CHANGE_OBJECTIVE', 'APPLY_GENERATION_PLAN', 'COMPLETE_WORKITEM', 'DECLARE_OUTCOME', 'APPROVE_WAIVER', 'PUBLISH_READOUT']) {
      expect(isProhibitedAutonomous(a)).toBe(true)
    }
    expect(isProhibitedAutonomous('EDIT_DOC_BLOCK')).toBe(false)
  })
})

describe('permission inheritance (∩)', () => {
  it('intersects human ∩ agent-role ∩ policy', () => {
    expect(effectiveTools(['A', 'B', 'C'], ['B', 'C', 'D'])).toEqual(['B', 'C'])
    expect(effectiveTools(['A', 'B', 'C'], ['B', 'C', 'D'], ['C'])).toEqual(['C'])
  })
  it('is empty when the human lacks the role tools', () => {
    expect(effectiveTools(['X'], ['A', 'B'])).toEqual([])
    expect(toolAllowed('A', ['X'], ['A', 'B'])).toBe(false)
    expect(toolAllowed('B', ['B'], ['A', 'B'])).toBe(true)
  })
})
