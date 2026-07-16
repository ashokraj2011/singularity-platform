/**
 * Tests for the claim-registry dispatcher's pure core — DB-free. The critical test
 * is the signed round-trip: the exact bytes the dispatcher signs must verify under
 * the exact scheme workgraph's incoming receiver enforces (HMAC-sha256 over
 * `${timestamp}.${body}`, sha256= prefix, timing-safe compare).
 */
import { describe, it, expect } from 'vitest'
import {
  patternToRegex, matchesAny, buildEnvelope, buildSignedDelivery, verifySignedDelivery,
  subjectKindFor, shouldRetry, MAX_DELIVERY_TRIES, type OutboxRowLike,
} from '../src/lib/dispatch-core'

const row = (over: Partial<OutboxRowLike> = {}): OutboxRowLike => ({
  id: 'out-1',
  eventType: 'claim.decay.threshold_crossed',
  aggregateId: 'claim-9',
  payload: { threshold: 0.8, posteriorProb: 0.74 },
  traceId: 't-1',
  createdAt: new Date('2026-07-16T06:00:00Z'),
  ...over,
})

describe('pattern matching (glob semantics copied from workgraph)', () => {
  it('exact, star-suffix, and lone star behave; star does not cross dots', () => {
    expect(matchesAny(['claim.falsified'], 'claim.falsified')).toBe(true)
    expect(matchesAny(['claim.decay.*'], 'claim.decay.threshold_crossed')).toBe(true)
    expect(matchesAny(['claim.*'], 'claim.decay.threshold_crossed')).toBe(false)
    expect(matchesAny(['*'], 'claim.created')).toBe(true)
    expect(patternToRegex('a.b').test('aXb')).toBe(false)
  })
})

describe('envelope + signing', () => {
  it('builds the canonical envelope with subject, source, and receipt id', () => {
    const env = buildEnvelope(row())
    expect(env.source_service).toBe('claim-registry')
    expect(env.receipt_id).toBe('out-1')
    expect(env.subject).toEqual({ kind: 'claim', id: 'claim-9' })
    expect(env.payload).toEqual({ threshold: 0.8, posteriorProb: 0.74 })
    expect(subjectKindFor('ambiguity.opened')).toBe('ambiguity')
  })
  it('round-trips: dispatcher signature verifies under the receiver scheme', () => {
    const { body, headers } = buildSignedDelivery(row(), 'shared-secret', 1752645600000)
    expect(headers['x-event-name']).toBe('claim.decay.threshold_crossed')
    expect(headers['x-event-outbox-id']).toBe('out-1')
    expect(headers['x-event-signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(verifySignedDelivery(body, headers, 'shared-secret')).toBe(true)
    expect(verifySignedDelivery(body, headers, 'wrong-secret')).toBe(false)
    expect(verifySignedDelivery(body + ' ', headers, 'shared-secret')).toBe(false)
  })
  it('unsigned delivery when no secret; retry stops at the 5th attempt', () => {
    const { headers } = buildSignedDelivery(row(), null, 0)
    expect(headers['x-event-signature']).toBeUndefined()
    expect(shouldRetry(3)).toBe(true)
    expect(shouldRetry(MAX_DELIVERY_TRIES - 1)).toBe(false)
  })
})
