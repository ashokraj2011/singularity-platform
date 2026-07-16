/**
 * Dispatch core — pure functions for the claim-registry event-bus dispatcher
 * (M11.e pattern, adapted to this service's simpler outbox schema). No I/O, no
 * clock (timestamps passed in), so the wire contract unit-tests without pg.
 *
 * Wire contract (must match every platform receiver, e.g. workgraph
 * /api/events/incoming):
 *   body    = {"event_name": <name>, "envelope": <canonical envelope>}
 *   headers = x-event-name, x-event-outbox-id, x-event-timestamp,
 *             x-event-signature: "sha256=" + HMAC_sha256(secret, `${ts}.${body}`)
 *   Receivers enforce a five-minute replay window on the timestamp and verify
 *   the HMAC over the EXACT bytes sent — so the body string signed here must be
 *   the body string POSTed, byte for byte.
 */
import crypto from 'node:crypto'

export const SOURCE_SERVICE = 'claim-registry'

/** Glob semantics copied from the workgraph dispatcher: `.` literal, `*` = [^.]*, anchored. */
export function patternToRegex(pattern: string): RegExp {
  if (pattern === '*') return /^.+$/ // lone star subscribes to everything (documented platform intent)
  if (!pattern.includes('*')) return new RegExp(`^${pattern.replace(/\./g, '\\.')}$`)
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*')
  return new RegExp(`^${re}$`)
}

/** EventSubscription.eventTypes is a String[] of exact names or globs — any match subscribes. */
export function matchesAny(eventTypes: string[], eventName: string): boolean {
  return eventTypes.some((p) => patternToRegex(p).test(eventName))
}

export interface OutboxRowLike {
  id: string
  eventType: string
  aggregateId: string
  payload: unknown
  traceId: string | null
  createdAt: Date
}

/** Canonical envelope shape (matches the receiver's EventEnvelope interface). */
export interface CanonicalEnvelope {
  receipt_id: string
  source_service: string
  trace_id: string | null
  subject: { kind: string; id: string }
  status: string
  started_at: string
  payload: Record<string, unknown>
}

const SUBJECT_KIND: Record<string, string> = {
  claim: 'claim',
  ambiguity: 'ambiguity',
  knowledge: 'knowledge_event',
  lowering: 'lowering_candidate',
}

export function subjectKindFor(eventType: string): string {
  return SUBJECT_KIND[eventType.split('.')[0] ?? ''] ?? 'claim'
}

export function buildEnvelope(row: OutboxRowLike): CanonicalEnvelope {
  return {
    receipt_id: row.id,
    source_service: SOURCE_SERVICE,
    trace_id: row.traceId,
    subject: { kind: subjectKindFor(row.eventType), id: row.aggregateId },
    status: 'emitted',
    started_at: row.createdAt.toISOString(),
    payload: (row.payload ?? {}) as Record<string, unknown>,
  }
}

export interface SignedDelivery {
  body: string
  headers: Record<string, string>
}

/** Serialize once, sign those exact bytes. `timestampMs` injected for testability. */
export function buildSignedDelivery(row: OutboxRowLike, secret: string | null, timestampMs: number): SignedDelivery {
  const body = JSON.stringify({ event_name: row.eventType, envelope: buildEnvelope(row) })
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-event-name': row.eventType,
    'x-event-outbox-id': row.id,
  }
  if (secret) {
    const ts = String(timestampMs)
    headers['x-event-timestamp'] = ts
    headers['x-event-signature'] =
      'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
  }
  return { body, headers }
}

/** Receiver-side verification, mirrored here so the round-trip is provable in tests. */
export function verifySignedDelivery(body: string, headers: Record<string, string>, secret: string): boolean {
  const sig = headers['x-event-signature']
  const ts = headers['x-event-timestamp']
  if (!sig || !ts) return false
  const [scheme, hex] = sig.split('=', 2)
  if (scheme !== 'sha256' || !hex) return false
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
  if (expected.length !== hex.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hex, 'hex'))
}

export const MAX_DELIVERY_TRIES = 5
export function shouldRetry(attemptsSoFar: number): boolean {
  return attemptsSoFar + 1 < MAX_DELIVERY_TRIES
}
