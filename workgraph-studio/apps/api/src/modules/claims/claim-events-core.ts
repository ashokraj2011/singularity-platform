/**
 * Claim events pure core (workgraph side) — the M-CR3 cross-service tail.
 * Deterministic helpers for turning an incoming claim-registry event into a
 * review flag on every WorkflowTemplate that references the claim. DB-free.
 *
 * Convention established by this PR:
 *   WorkflowTemplate.metadata.claimRefs   : Array<{ claimId, snapshotId?, note? }>
 *       — written by designers (or the studio) when a template is justified by
 *         a SPEC_BOUND claim. The resolver's `claim` kind validates these at
 *         write time.
 *   WorkflowTemplate.metadata.claimReview : Array<ReviewFlag>
 *       — appended by the incoming-event handler; cleared by a human from the
 *         template UI. Idempotent per (claimId, eventName, outboxId).
 */

export const CLAIM_REVIEW_EVENTS = new Set(['claim.decay.threshold_crossed', 'claim.falsified'])

export interface ClaimRef {
  claimId: string
  snapshotId?: string
  note?: string
}

export interface ReviewFlag {
  claimId: string
  eventName: string
  outboxId: string
  threshold?: number
  posteriorProb?: number
  flaggedAt: string
}

export function isClaimReviewEvent(eventName: string): boolean {
  return CLAIM_REVIEW_EVENTS.has(eventName)
}

/** Tolerant extraction — metadata is a loose Json blob; never throw on shape. */
export function extractClaimRefs(metadata: unknown): ClaimRef[] {
  if (!metadata || typeof metadata !== 'object') return []
  const refs = (metadata as Record<string, unknown>).claimRefs
  if (!Array.isArray(refs)) return []
  return refs
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .filter((r) => typeof r.claimId === 'string' && r.claimId.length > 0)
    .map((r) => ({ claimId: r.claimId as string, snapshotId: typeof r.snapshotId === 'string' ? r.snapshotId : undefined, note: typeof r.note === 'string' ? r.note : undefined }))
}

export function referencesClaim(metadata: unknown, claimId: string): boolean {
  return extractClaimRefs(metadata).some((r) => r.claimId === claimId)
}

/**
 * Append a review flag, idempotently: the same (claimId, eventName, outboxId)
 * never flags twice — redelivered webhooks are a fact of life. Returns null when
 * nothing changed so the caller can skip the write.
 */
export function applyReviewFlag(metadata: unknown, flag: ReviewFlag): Record<string, unknown> | null {
  const base: Record<string, unknown> = metadata && typeof metadata === 'object' ? { ...(metadata as Record<string, unknown>) } : {}
  const existing = Array.isArray(base.claimReview) ? (base.claimReview as ReviewFlag[]) : []
  const duplicate = existing.some((f) => f && f.claimId === flag.claimId && f.eventName === flag.eventName && f.outboxId === flag.outboxId)
  if (duplicate) return null
  base.claimReview = [...existing, flag]
  return base
}

export interface ClaimEventEnvelopeLike {
  receipt_id?: string
  subject?: { kind?: string; id?: string }
  payload?: Record<string, unknown>
}

/** Pull the fields the handler needs; null when the envelope isn't a claim event we act on. */
export function reviewFlagFrom(eventName: string, outboxId: string, envelope: ClaimEventEnvelopeLike, nowIso: string): ReviewFlag | null {
  if (!isClaimReviewEvent(eventName)) return null
  const claimId = envelope.subject?.id
  if (!claimId || envelope.subject?.kind !== 'claim') return null
  const payload = envelope.payload ?? {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  return {
    claimId,
    eventName,
    outboxId,
    threshold: num(payload.threshold),
    posteriorProb: num(payload.posteriorProb ?? payload.posterior_prob),
    flaggedAt: nowIso,
  }
}
