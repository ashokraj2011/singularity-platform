/**
 * M11.e — event-bus publisher.
 *
 * Writes a row into `event_outbox` and triggers `pg_notify` so the dispatcher
 * picks it up immediately. The outbox row IS the durable record — even if
 * the NOTIFY is missed (process restart between INSERT and NOTIFY), the
 * dispatcher's safety-sweep timer will pick the row up on the next tick.
 *
 * Envelope shape is the same canonical Receipt envelope (M11.d) so an
 * `agent.run.completed` event carries everything a subscriber needs to
 * correlate without an extra round-trip.
 */

import { prisma } from '../prisma'
import { Prisma } from '@prisma/client'

export const EVENT_CHANNEL = 'event_outbox_workgraph'

export interface EventEnvelope {
  receipt_id?:    string
  kind?:          string                 // e.g. "agent_run", "approval"
  source_service: string                 // "workgraph-api"
  trace_id?:      string | null
  subject:        { kind: string; id: string }
  actor?:         { kind: string; id: string | null } | null
  status?:        string                 // started | completed | failed | paused | approved | rejected
  started_at?:    string | null
  completed_at?:  string | null
  correlation?:   Record<string, unknown>
  metrics?:       Record<string, unknown>
  payload?:       Record<string, unknown>
}

export interface PublishOpts {
  eventName: string                       // e.g. "agent.run.completed"
  envelope:  EventEnvelope
}

export async function publishEvent({ eventName, envelope }: PublishOpts): Promise<string> {
  const row = await prisma.eventOutbox.create({
    data: {
      eventName,
      sourceService: envelope.source_service,
      traceId:       envelope.trace_id ?? null,
      subjectKind:   envelope.subject.kind,
      subjectId:     envelope.subject.id,
      envelope:      envelope as unknown as Prisma.InputJsonValue,
    },
  })
  // NOTIFY with the outbox id as payload so the dispatcher knows which row to pick.
  // Wrapped in try/catch — even if notify fails, the safety-sweep timer will catch it.
  try {
    await prisma.$executeRaw`SELECT pg_notify(${EVENT_CHANNEL}, ${row.id})`
  } catch {
    // swallow — durable record exists, sweep will deliver
  }
  return row.id
}
