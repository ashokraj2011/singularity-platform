/**
 * M11.e — tool-service event-bus publisher.
 *
 * Same canonical envelope shape as workgraph + IAM + agent-runtime.
 * tool-service uses raw pg (no Prisma) — INSERT into agent.event_outbox
 * + pg_notify('event_outbox_agent_service', id) so the dispatcher picks
 * the row up immediately.
 */
import { pool } from "../../database";

export const EVENT_CHANNEL = "event_outbox_agent_service";

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

export async function publishEvent(opts: { eventName: string; envelope: EventEnvelope }): Promise<string> {
  const { eventName, envelope } = opts;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO agent.event_outbox
       (event_name, source_service, trace_id, subject_kind, subject_id, envelope)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      eventName, envelope.source_service, envelope.trace_id ?? null,
      envelope.subject.kind, envelope.subject.id, envelope,
    ],
  );
  const id = rows[0].id;
  try {
    await pool.query(`SELECT pg_notify($1, $2)`, [EVENT_CHANNEL, id]);
  } catch {
    // safety sweep will pick it up
  }
  return id;
}
