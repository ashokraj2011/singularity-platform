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
import { runWithTenantDbContext } from '../../lib/tenant-db-context'
import { fanOutToWorkItemTriggers } from '../work-items/work-item-event-fanout'
import { systemRouteActor } from '../work-items/work-item-actors'
import { assertEventPayloadSize, redactEventPayload } from '../events/event-payload'

export const incomingEventsRouter: Router = Router()

interface EventEnvelope {
  receipt_id?:    string
  kind?:          string
  source_service: string
  tenant_id?: string | null
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

type RawBodyRequest = Request & { rawBody?: Buffer }

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

function requestBodyForSignature(req: Request, fallbackBody: string): Buffer | string {
  const rawBody = (req as RawBodyRequest).rawBody
  return rawBody && rawBody.length > 0 ? rawBody : fallbackBody
}

function verifySignature(req: Request, body: Buffer | string, secret: string): boolean {
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
  const outboxId  = req.header('x-event-outbox-id') ?? body?.envelope?.receipt_id
  const timestampHeader = req.header('x-event-timestamp')
  const deployment = (process.env.APP_ENV ?? process.env.ENVIRONMENT ?? process.env.SINGULARITY_ENV ?? config.NODE_ENV ?? 'development').toLowerCase()
  const productionClass = ['production', 'prod', 'staging', 'perf'].includes(deployment)
  if (!body || !eventName || !body.envelope) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'event_name + envelope required' })
  }
  const source = body.envelope.source_service
  if (!source || source === 'unknown') {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'envelope.source_service is required' })
  }
  if (!outboxId) {
    return res.status(400).json({ code: 'MISSING_EVENT_ID', message: 'x-event-outbox-id or envelope.receipt_id is required for idempotent delivery' })
  }
  if (productionClass && !timestampHeader) {
    return res.status(400).json({ code: 'MISSING_EVENT_TIMESTAMP', message: 'x-event-timestamp is required in production-class deployments' })
  }
  if (timestampHeader) {
    const timestamp = Number(timestampHeader)
    const timestampMs = Number.isFinite(timestamp) ? (timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp) : NaN
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) {
      return res.status(401).json({ code: 'STALE_EVENT', message: 'Signed event timestamp is outside the five-minute replay window' })
    }
  }

  // HMAC verify for every source; unconfigured sources are not trusted.
  const secrets = loadSecrets()
  const secret = secrets[source]
  if (!secret) {
    return res.status(401).json({ code: 'UNTRUSTED_SOURCE', message: `No incoming event secret configured for ${source}` })
  }
  // Verify the HMAC over the exact bytes that Express received. Re-serialization
  // changes insignificant JSON whitespace/order and makes valid events fragile.
  // The compact fallback covers tests or embedded callers that invoke the router
  // without passing through the app-level raw-body capture middleware.
  const compactFallback = JSON.stringify({ event_name: eventName, envelope: body.envelope })
  const exactBody = requestBodyForSignature(req, compactFallback)
  const signedBody = timestampHeader
    ? (Buffer.isBuffer(exactBody) ? Buffer.concat([Buffer.from(`${timestampHeader}.`), exactBody]) : `${timestampHeader}.${exactBody}`)
    : exactBody
  if (!verifySignature(req, signedBody, secret)) {
    return res.status(401).json({ code: 'BAD_SIGNATURE', message: 'HMAC verification failed' })
  }

  const tenantId = body.envelope.tenant_id
    ?? (typeof body.envelope.correlation?.tenantId === 'string' ? body.envelope.correlation.tenantId : undefined)
    ?? (typeof body.envelope.payload?.tenantId === 'string' ? body.envelope.payload.tenantId : undefined)
  if (config.TENANT_ISOLATION_MODE === 'strict' && !tenantId) {
    return res.status(403).json({ code: 'MISSING_EVENT_TENANT', message: 'Strict tenant isolation requires envelope.tenant_id' })
  }
  assertEventPayloadSize(body.envelope)
  const safeEnvelope = redactEventPayload(body.envelope)

  // Persist into workgraph audit log so the unified /api/receipts timeline
  // surfaces inbound cross-service events alongside local ones.
  try {
    await runWithTenantDbContext(tenantId, () => prisma.eventLog.create({
    data: {
      eventType:  `incoming.${eventName}`,
      entityType: body.envelope.subject?.kind ?? 'unknown',
      entityId:   body.envelope.subject?.id ?? outboxId ?? 'unknown',
      actorId:    null,
      traceId:    body.envelope.trace_id ?? undefined,
      tenantId,
      payload: {
        source_service: source,
        event_name:     eventName,
        outbox_id:      outboxId,
        trace_id:       body.envelope.trace_id ?? null,
        traceId:        body.envelope.trace_id ?? null,
        tenant_id:      tenantId ?? null,
        envelope:       safeEnvelope,
      } as object,
    },
    }))
  } catch (err) {
    console.error('[incoming-events] persist failed:', (err as Error).message)
    return res.status(503).json({ code: 'EVENT_PERSISTENCE_FAILED', message: 'Event was authenticated but could not be durably recorded; retryable=true', retryable: true })
  }

  // Fan out to WorkItem EVENT triggers so a verified cross-service event actually
  // starts work (create/attach a WorkItem + route/AUTO_START) instead of being
  // logged and dropped. Dedup on the upstream outbox id (a true per-delivery id)
  // makes re-delivery exactly-once. Best-effort: a fan-out failure must not turn a
  // successfully-received (and logged) event into a 5xx that triggers upstream retries.
  let workItemIds: string[] = []
  try {
    workItemIds = await runWithTenantDbContext(tenantId, () => fanOutToWorkItemTriggers({
      eventTypeKey: eventName,
      payload: body.envelope.payload ?? (body.envelope as unknown as Record<string, unknown>),
      deliveryId: outboxId,
      sourceEventTypeKey: eventName,
      traceId: body.envelope.trace_id,
      actorId: systemRouteActor('event-trigger'),
    }))
  } catch (err) {
    console.error('[incoming-events] trigger fan-out failed:', (err as Error).message)
    return res.status(503).json({ code: 'EVENT_FANOUT_FAILED', message: 'Event was recorded but routing did not complete; retryable=true', retryable: true, recorded_event: eventName })
  }

  return res.status(200).json({ ok: true, recorded_event: eventName, source, workItemIds })
})
