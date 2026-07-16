/**
 * Events + receipts (M11.e outbox + M11.d receipt envelope). M-CR1 writes the
 * outbox row + the receipt row here; the LISTEN/NOTIFY dispatcher (HMAC, 5-attempt
 * retry) is the copied M11.e delivery loop, wired in during M-CR1 hardening.
 * Fire-and-forget: emitting an event must never fail the write that produced it.
 */
import { prisma } from './prisma';

export async function publishEvent(eventType: string, aggregateId: string, payload: Record<string, unknown>, traceId?: string): Promise<void> {
  try {
    await prisma.eventOutbox.create({ data: { eventType, aggregateId, payload: payload as object, traceId: traceId ?? null } });
  } catch {
    /* best-effort — the ledger is downstream of the domain write */
  }
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
  try {
    await prisma.receipt.create({
      data: {
        traceId: input.traceId, kind: input.kind,
        subjectKind: input.subjectKind, subjectId: input.subjectId,
        actorKind: input.actorKind, actorId: input.actorId,
        status: input.status, payload: (input.payload ?? {}) as object,
      },
    });
  } catch {
    /* best-effort */
  }
}
