import { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { publishEvent } from './eventbus/publisher'
import { emitAuditEvent } from './audit-gov-emit'
import { redactSecrets } from './redact'
import { currentTenantIdForDb } from './tenant-db-context'

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
  // [P2] Redact secrets at the audit sink — defense-in-depth so nothing lands in
  // the ledger with a token/key, regardless of whether the caller pre-redacted.
  const safePayload = payload ? redactSecrets(payload) : payload
  const traceId = typeof safePayload?.traceId === 'string'
    ? safePayload.traceId
    : typeof safePayload?.trace_id === 'string'
      ? safePayload.trace_id
      : undefined
  const requestTenantId = currentTenantIdForDb()
  const tenantId = requestTenantId
    ?? (typeof safePayload?.tenantId === 'string'
      ? safePayload.tenantId
      : typeof safePayload?.tenant_id === 'string'
        ? safePayload.tenant_id
        : undefined)
  const event = await prisma.eventLog.create({
    data: {
      eventType,
      entityType,
      entityId,
      actorId,
      traceId,
      tenantId,
      payload: safePayload as unknown as Prisma.InputJsonValue,
    },
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
  const safeContent = redactSecrets(content)
  await prisma.receipt.create({
    data: { receiptType, entityType, entityId, content: safeContent as unknown as Prisma.InputJsonValue, eventLogId },
  })
}

export async function publishOutbox(
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // [P2] Redact secrets ONCE at the audit sink, then use the safe copy for every
  // persistence target (outbox + canonical event-bus + audit-gov ledger) so no
  // secret reaches any of them regardless of the caller. Non-secret correlation
  // fields (traceId/actorId/capabilityId) are unaffected by the patterns.
  const safe = redactSecrets(payload)
  const requestTenantId = currentTenantIdForDb()
  const tenantId = requestTenantId
    ?? (typeof safe.tenantId === 'string'
      ? safe.tenantId
      : typeof safe.tenant_id === 'string'
        ? safe.tenant_id
        : undefined)

  // Legacy outbox row (kept for back-compat with existing OutboxProcessor).
  await prisma.outboxEvent.create({
    data: { aggregateType, aggregateId, eventType, payload: safe as unknown as Prisma.InputJsonValue },
  })

  // M11.e — also emit a canonical event-bus row. Failures don't block the
  // legacy write; the event-bus is best-effort at the producer side and
  // self-healing via the dispatcher's safety sweep.
  try {
    await publishEvent({
      eventName: toCanonicalEventName(eventType),
      envelope: {
        source_service: 'workgraph-api',
        trace_id:       (safe.traceId as string | undefined) ?? null,
        tenant_id:      tenantId ?? null,
        subject:        { kind: aggregateToSubjectKind(aggregateType), id: aggregateId },
        actor:          safe.actorId ? { kind: 'user', id: safe.actorId as string } : null,
        status:         'emitted',
        started_at:     new Date().toISOString(),
        correlation:    safe as Record<string, unknown>,
        payload:        safe as Record<string, unknown>,
      },
    })
  } catch (err) {
    // never let event-bus problems break audit
    console.warn('[eventbus] publishEvent failed:', (err as Error).message)
  }

  // M22 — central audit-governance ledger (fire-and-forget). Every workgraph
  // state transition that goes through publishOutbox lands in audit_events.
  emitAuditEvent({
    trace_id:       (safe.traceId as string | undefined),
    source_service: 'workgraph-api',
    kind:           toCanonicalEventName(eventType),
    subject_type:   aggregateType,
    subject_id:     aggregateId,
    actor_id:       (safe.actorId as string | undefined),
    capability_id:  (safe.capabilityId as string | undefined),
    severity:       'info',
    payload:        safe,
  })
}
