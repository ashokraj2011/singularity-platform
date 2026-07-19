/**
 * Synthesis Studio — proposal contract pure core (R1A Proposals phase). The per-item
 * content-hash stale fence + the decision/settling rules, PURE so they unit-test directly.
 */
export type ItemStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EDITED' | 'APPLIED' | 'STALE'

/**
 * The per-item content-hash stale fence: if the item declared a base hash and the target's
 * CURRENT hash differs, the item is stale and must be rebased before it can apply. No base
 * hash declared → no fence (not stale).
 */
export function isItemStale(baseContentHash: string | null | undefined, currentContentHash: string | null | undefined): boolean {
  if (!baseContentHash) return false
  return baseContentHash !== (currentContentHash ?? null)
}

/** Only a PENDING item can be decided; a second decision on an already-settled item is rejected. */
export function canDecideItem(status: ItemStatus): boolean {
  return status === 'PENDING'
}

/**
 * Settle the parent proposal from its items: still PENDING while any item is PENDING or STALE
 * (needs rebase); ACCEPTED if any item was accepted/applied; otherwise REJECTED.
 */
export function settleProposalStatus(itemStatuses: ItemStatus[]): 'PENDING' | 'ACCEPTED' | 'REJECTED' {
  if (itemStatuses.some((s) => s === 'PENDING' || s === 'STALE')) return 'PENDING'
  const anyAccepted = itemStatuses.some((s) => s === 'APPLIED' || s === 'ACCEPTED' || s === 'EDITED')
  return anyAccepted ? 'ACCEPTED' : 'REJECTED'
}
