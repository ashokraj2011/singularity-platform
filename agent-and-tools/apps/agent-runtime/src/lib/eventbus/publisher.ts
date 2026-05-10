/**
 * M11.e — agent-runtime event-bus publisher.
 *
 * Same canonical envelope shape as workgraph + IAM so subscribers can
 * consume any service uniformly. Writes a row into `event_outbox` and
 * triggers pg_notify so the dispatcher picks it up immediately.
 */

import type { PrismaClient, Prisma } from "@prisma/client";

export const EVENT_CHANNEL = "event_outbox_agent_runtime";

export interface EventEnvelope {
  receipt_id?:    string;
  kind?:          string;
  source_service: string;
  trace_id?:      string | null;
  subject:        { kind: string; id: string };
  actor?:         { kind: string; id: string | null } | null;
  status?:        string;
  started_at?:    string | null;
  completed_at?:  string | null;
  correlation?:   Record<string, unknown>;
  metrics?:       Record<string, unknown>;
  payload?:       Record<string, unknown>;
}

export async function publishEvent(
  prisma: PrismaClient,
  opts: { eventName: string; envelope: EventEnvelope },
): Promise<string> {
  const row = await prisma.eventOutbox.create({
    data: {
      eventName:     opts.eventName,
      sourceService: opts.envelope.source_service,
      traceId:       opts.envelope.trace_id ?? null,
      subjectKind:   opts.envelope.subject.kind,
      subjectId:     opts.envelope.subject.id,
      envelope:      opts.envelope as unknown as Prisma.InputJsonValue,
    },
  });
  try {
    await prisma.$executeRaw`SELECT pg_notify(${EVENT_CHANNEL}, ${row.id})`;
  } catch {
    // safety sweep will pick it up
  }
  return row.id;
}
