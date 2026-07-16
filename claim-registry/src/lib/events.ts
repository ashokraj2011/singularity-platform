/**
 * Events + receipts (M11.e outbox + M11.d receipt envelope). M-CR1 writes the
 * outbox row + the receipt row here; the LISTEN/NOTIFY dispatcher (HMAC, 5-attempt
 * retry) is the copied M11.e delivery loop, wired in during M-CR1 hardening.
 * Event and receipt rows are part of the durable write contract. A failed outbox
 * or receipt insert is surfaced to the caller instead of being silently lost.
 */
import { prisma } from './prisma';
import { currentRegistryTenant } from './request-context';

export async function publishEvent(eventType: string, aggregateId: string, payload: Record<string, unknown>, traceId?: string): Promise<void> {
  const row = await prisma.eventOutbox.create({ data: { tenantId: currentRegistryTenant(), eventType, aggregateId, payload: payload as object, traceId: traceId ?? null } });
  // Wake the dispatcher immediately (best-effort). The 30s sweep is the delivery
  // guarantee; a lost notify only costs latency, so it must never fail the write.
  try {
    await prisma.$executeRawUnsafe(`SELECT pg_notify('event_outbox_claim_registry', $1)`, row.id);
  } catch { /* notify is a latency optimization, not part of the durable write contract */ }
}

export interface ReceiptInput {
  traceId: string;
  kind: string;
  subjectKind: string;
  subjectId: string;
  actorKind: string;
  actorId: string;
  status: string;
  payload?: Record<string, unknown>;
}

export async function emitReceipt(input: ReceiptInput): Promise<void> {
  await prisma.receipt.create({
    data: {
      tenantId: currentRegistryTenant(), traceId: input.traceId, kind: input.kind,
      subjectKind: input.subjectKind, subjectId: input.subjectId,
      actorKind: input.actorKind, actorId: input.actorId,
      status: input.status, payload: (input.payload ?? {}) as object,
    },
  });
}
