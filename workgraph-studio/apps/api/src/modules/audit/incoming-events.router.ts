/**
 * M11.e cross-service receiver — webhook endpoint that other services post
 * events to via their own event-bus dispatcher.
 *
 * Headers expected (set by every dispatcher in the platform):
 *   x-event-name        — canonical name (e.g. "capability.created")
 *   x-event-outbox-id   — upstream outbox row id (for idempotency / dedupe)
 *   x-event-signature   — "sha256=<hex>" if subscriber registered with secret
 *
 * On receipt we:
 *   1. Verify HMAC with the shared secret configured for the upstream
 *      service (env: WORKGRAPH_INCOMING_EVENT_SECRETS, JSON keyed by
 *      source_service: { "iam": "<secret>", "agent-runtime": "<secret>", ... })
 *   2. Persist into workgraph EventLog (existing audit table) with
 *      eventType = `incoming.${event_name}` and payload = the envelope.
 *   3. Optionally fan to local handlers based on event_name (none today;
 *      this is the hook for cache-invalidation, snapshot refresh, etc.)
 *
 * Endpoint is unauthenticated at the user-auth layer but always signature-gated.
 * Missing source secrets fail closed instead of accepting unsigned events.
 */

import { Router, type Request } from 'express'
import crypto from 'node:crypto'
import { config } from '../../config'
import { prisma } from '../../lib/prisma'

export const incomingEventsRouter: Router = Router()

interface EventEnvelope {
  receipt_id?:    string
  kind?:          string
  source_service: string
  trace_id?:      string | null
  subject:        { kind: string; id: string }
  actor?:         { kind: string; id: string | null } | null
  status?:        string
  started_at?:    string | null
  completed_at?:  string | null
  correlation?:   Record<string, unknown>
  metrics?:       Record<string, unknown>
  payload?:       Record<string, unknown>
}

interface IncomingBody {
  event_name: string
  envelope:   EventEnvelope
}

function loadSecrets(): Record<string, string> {
  const raw = config.WORKGRAPH_INCOMING_EVENT_SECRETS
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([source, secret]) => source.trim().length > 0 && typeof secret === 'string' && secret.trim().length > 0)
        .map(([source, secret]) => [source, (secret as string).trim()]),
    )
  }
  catch { return {} }
}

function verifySignature(req: Request, body: string, secret: string): boolean {
  const sigHeader = req.header('x-event-signature')
  if (!sigHeader) return false
  const [scheme, hex] = sigHeader.split('=', 2)
  if (scheme !== 'sha256' || !hex) return false
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex')
  // Constant-time compare; lengths must match.
  if (expected.length !== hex.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hex, 'hex'))
  } catch { return false }
}

incomingEventsRouter.post('/', async (req, res) => {
  const body = req.body as IncomingBody | undefined
  const eventName = req.header('x-event-name') ?? body?.event_name
  const outboxId  = req.header('x-event-outbox-id')
  if (!body || !eventName || !body.envelope) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'event_name + envelope required' })
  }
  const source = body.envelope.source_service
  if (!source || source === 'unknown') {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'envelope.source_service is required' })
  }

  // HMAC verify for every source; unconfigured sources are not trusted.
  const secrets = loadSecrets()
  const secret = secrets[source]
  if (!secret) {
    return res.status(401).json({ code: 'UNTRUSTED_SOURCE', message: `No incoming event secret configured for ${source}` })
  }
  // Re-serialize from parsed body to compare against signature over the
  // exact bytes the dispatcher sent. The platform dispatchers use compact JSON.
  const reserialized = JSON.stringify({ event_name: eventName, envelope: body.envelope })
  if (!verifySignature(req, reserialized, secret)) {
    return res.status(401).json({ code: 'BAD_SIGNATURE', message: 'HMAC verification failed' })
  }

  // Persist into workgraph audit log so the unified /api/receipts timeline
  // surfaces inbound cross-service events alongside local ones.
  await prisma.eventLog.create({
    data: {
      eventType:  `incoming.${eventName}`,
      entityType: body.envelope.subject?.kind ?? 'unknown',
      entityId:   body.envelope.subject?.id ?? outboxId ?? 'unknown',
      actorId:    null,
      payload: {
        source_service: source,
        event_name:     eventName,
        outbox_id:      outboxId,
        envelope:       body.envelope,
      } as object,
    },
  }).catch((err) => {
    console.warn('[incoming-events] persist failed:', (err as Error).message)
  })

  // TODO: fan to local handlers (cache invalidation, snapshot refresh).
  // For now, ack-and-log is enough to prove the wire.
  return res.status(200).json({ ok: true, recorded_event: eventName, source })
})
