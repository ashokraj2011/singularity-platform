import { describe, expect, it } from 'vitest'
import {
  canTransition, requiresPinnedBlocks, isEditable, DOC_TRANSITIONS, type DocStatus,
} from '../src/modules/synthesis/document-lifecycle'

/**
 * Synthesis Documents — the pure lifecycle rules the service leans on: legal edges,
 * which states freeze content (force PINNED + contentHash), and which allow editing.
 */
describe('document lifecycle state machine', () => {
  it('allows the legal edges and rejects skips/reversals', () => {
    expect(canTransition('DRAFT', 'IN_REVIEW')).toBe(true)
    expect(canTransition('IN_REVIEW', 'APPROVED')).toBe(true)
    expect(canTransition('APPROVED', 'PUBLISHED')).toBe(true)
    expect(canTransition('DRAFT', 'APPROVED')).toBe(false) // no skipping review
    expect(canTransition('APPROVED', 'DRAFT')).toBe(false) // no un-approve
    expect(canTransition('PUBLISHED', 'DRAFT')).toBe(false)
  })
  it('treats ARCHIVED as terminal', () => {
    expect(DOC_TRANSITIONS.ARCHIVED).toEqual([])
    expect(canTransition('ARCHIVED', 'DRAFT')).toBe(false)
  })
  it('makes archival reachable from every non-terminal state', () => {
    const nonTerminal: DocStatus[] = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED', 'SUPERSEDED']
    for (const s of nonTerminal) expect(canTransition(s, 'ARCHIVED')).toBe(true)
  })
})

describe('freeze + edit rules', () => {
  it('freezes content (force PINNED) in APPROVED and beyond, not in drafts', () => {
    expect(requiresPinnedBlocks('APPROVED')).toBe(true)
    expect(requiresPinnedBlocks('PUBLISHED')).toBe(true)
    expect(requiresPinnedBlocks('SUPERSEDED')).toBe(true)
    expect(requiresPinnedBlocks('ARCHIVED')).toBe(true)
    expect(requiresPinnedBlocks('DRAFT')).toBe(false)
    expect(requiresPinnedBlocks('IN_REVIEW')).toBe(false)
  })
  it('permits editing only in DRAFT / CHANGES_REQUESTED', () => {
    expect(isEditable('DRAFT')).toBe(true)
    expect(isEditable('CHANGES_REQUESTED')).toBe(true)
    expect(isEditable('IN_REVIEW')).toBe(false)
    expect(isEditable('APPROVED')).toBe(false)
    expect(isEditable('PUBLISHED')).toBe(false)
  })
})
