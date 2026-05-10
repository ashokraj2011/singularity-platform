import { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { publishEvent } from './eventbus/publisher'

/**
 * M11.e — convert legacy PascalCase eventType strings (e.g. "AgentRunCompleted",
 * "WorkflowRunCreated") into the canonical dotted form ("agent.run.completed",
 * "workflow.run.created"). Pure helper — easy to override by passing an
 * explicit `eventName` to `publishOutbox`.
 */
function toCanonicalEventName(eventType: string): string {
  // Split on capital letters, drop empties, lowercase, join with dots.
  return eventType
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join('.')
}

function aggregateToSubjectKind(aggregateType: string): string {
  return toCanonicalEventName(aggregateType).replace(/\./g, '_')
}

export async function logEvent(
  eventType: string,
  entityType: string,
  entityId: string,
  actorId?: string,
  payload?: Record<string, unknown>,
): Promise<string> {
  const event = await prisma.eventLog.create({
    data: { eventType, entityType, entityId, actorId, payload: payload as unknown as Prisma.InputJsonValue },
  })
  return event.id
}

export async function createReceipt(
  receiptType: string,
  entityType: string,
  entityId: string,
  content: Record<string, unknown>,
  eventLogId?: string,
): Promise<void> {
  await prisma.receipt.create({
    data: { receiptType, entityType, entityId, content: content as unknown as Prisma.InputJsonValue, eventLogId },
  })
}

export async function publishOutbox(
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Legacy outbox row (kept for back-compat with existing OutboxProcessor).
  await prisma.outboxEvent.create({
    data: { aggregateType, aggregateId, eventType, payload: payload as unknown as Prisma.InputJsonValue },
  })

  // M11.e — also emit a canonical event-bus row. Failures don't block the
  // legacy write; the event-bus is best-effort at the producer side and
  // self-healing via the dispatcher's safety sweep.
  try {
    await publishEvent({
      eventName: toCanonicalEventName(eventType),
      envelope: {
        source_service: 'workgraph-api',
        trace_id:       (payload.traceId as string | undefined) ?? null,
        subject:        { kind: aggregateToSubjectKind(aggregateType), id: aggregateId },
        actor:          payload.actorId ? { kind: 'user', id: payload.actorId as string } : null,
        status:         'emitted',
        started_at:     new Date().toISOString(),
        correlation:    payload as Record<string, unknown>,
        payload:        payload as Record<string, unknown>,
      },
    })
  } catch (err) {
    // never let event-bus problems break audit
    console.warn('[eventbus] publishEvent failed:', (err as Error).message)
  }
}
