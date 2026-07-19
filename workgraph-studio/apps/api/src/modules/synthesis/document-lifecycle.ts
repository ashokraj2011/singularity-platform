/**
 * Synthesis Studio — document lifecycle (R1A Documents phase). PURE: the legal state
 * machine + the freeze/edit rules, so they unit-test without the DB. A document is
 * editable only while DRAFT/CHANGES_REQUESTED; entering a frozen state (APPROVED and
 * beyond) forces every block PINNED and stamps a contentHash.
 */
export type DocStatus =
  | 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUESTED'
  | 'APPROVED' | 'PUBLISHED' | 'SUPERSEDED' | 'ARCHIVED'

// Legal edges. APPROVED needs an independent reviewer (enforced in the service);
// PUBLISHED follows APPROVED; ARCHIVED is reachable from anywhere non-terminal.
export const DOC_TRANSITIONS: Record<DocStatus, DocStatus[]> = {
  DRAFT: ['IN_REVIEW', 'ARCHIVED'],
  IN_REVIEW: ['CHANGES_REQUESTED', 'APPROVED', 'ARCHIVED'],
  CHANGES_REQUESTED: ['DRAFT', 'IN_REVIEW', 'ARCHIVED'],
  APPROVED: ['PUBLISHED', 'SUPERSEDED', 'ARCHIVED'],
  PUBLISHED: ['SUPERSEDED', 'ARCHIVED'],
  SUPERSEDED: ['ARCHIVED'],
  ARCHIVED: [],
}

export function canTransition(from: DocStatus, to: DocStatus): boolean {
  return (DOC_TRANSITIONS[from] ?? []).includes(to)
}

// States in which content is frozen: every block must be PINNED and a contentHash stamped.
export const FROZEN_STATES: readonly DocStatus[] = ['APPROVED', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED']
export function requiresPinnedBlocks(status: DocStatus): boolean {
  return FROZEN_STATES.includes(status)
}

// States in which blocks may be authored/edited.
export const EDITABLE_STATES: readonly DocStatus[] = ['DRAFT', 'CHANGES_REQUESTED']
export function isEditable(status: DocStatus): boolean {
  return EDITABLE_STATES.includes(status)
}
