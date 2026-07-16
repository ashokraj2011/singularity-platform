/**
 * Tests for the workgraph claim-event pure core — DB-free. The cross-service tail's
 * deterministic half: recognizing the two review events, extracting claimRefs
 * tolerantly, and appending review flags idempotently (redelivery never double-flags).
 */
import { describe, it, expect } from 'vitest'
import {
  isClaimReviewEvent, extractClaimRefs, referencesClaim, applyReviewFlag, reviewFlagFrom,
} from '../src/modules/claims/claim-events-core'

describe('workgraph claim-event core', () => {
  const metadata = { claimRefs: [{ claimId: 'claim-9', snapshotId: 'snap-1' }, { claimId: 'claim-2' }], other: 1 }

  it('recognizes exactly the two review events', () => {
    expect(isClaimReviewEvent('claim.falsified')).toBe(true)
    expect(isClaimReviewEvent('claim.decay.threshold_crossed')).toBe(true)
    expect(isClaimReviewEvent('claim.posterior.updated')).toBe(false)
  })
  it('extracts refs tolerantly and matches by claimId', () => {
    expect(extractClaimRefs(metadata)).toHaveLength(2)
    expect(extractClaimRefs(null)).toEqual([])
    expect(extractClaimRefs({ claimRefs: 'nope' })).toEqual([])
    expect(referencesClaim(metadata, 'claim-9')).toBe(true)
    expect(referencesClaim(metadata, 'claim-404')).toBe(false)
  })
  it('builds the flag from the envelope, only for claim subjects', () => {
    const flag = reviewFlagFrom('claim.decay.threshold_crossed', 'out-1', { subject: { kind: 'claim', id: 'claim-9' }, payload: { threshold: 0.8, posteriorProb: 0.74 } }, '2026-07-16T06:01:00Z')
    expect(flag).toMatchObject({ claimId: 'claim-9', threshold: 0.8, posteriorProb: 0.74 })
    expect(reviewFlagFrom('claim.falsified', 'o', { subject: { kind: 'room', id: 'x' } }, 'now')).toBeNull()
    expect(reviewFlagFrom('claim.created', 'o', { subject: { kind: 'claim', id: 'x' } }, 'now')).toBeNull()
  })
  it('applies the review flag idempotently — redelivery never double-flags', () => {
    const flag = { claimId: 'claim-9', eventName: 'claim.falsified', outboxId: 'out-7', flaggedAt: 'now' }
    const once = applyReviewFlag(metadata, flag)
    expect(once).not.toBeNull()
    expect((once!.claimReview as unknown[]).length).toBe(1)
    expect(once!.other).toBe(1)
    expect(applyReviewFlag(once, flag)).toBeNull()
    const differentDelivery = applyReviewFlag(once, { ...flag, outboxId: 'out-8' })
    expect((differentDelivery!.claimReview as unknown[]).length).toBe(2)
  })
})
