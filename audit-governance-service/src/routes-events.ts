/**
 * M21 — event ingestion (Chunk 2).
 *
 * POST /events           — single event ingest. Synchronous; returns the new
 *                          audit_event id. Used by services that need ACK.
 * POST /events/batch     — many at once.
 *
 * The cost worker fires inline for `llm.call.completed` so the llm_calls row
 * is in place by the time the producer's HTTP call returns. For batch the
 * worker runs per-event sequentially — fine at the volumes we're targeting.
 */
import { Router, Request, Response } from "express";
import { query } from "./db";
import { eventSchema, authzDecisionSchema } from "./types";
import { denormaliseLlmCall } from "./cost-worker";

export const eventsRouter = Router();

async function ingestOne(input: unknown): Promise<{ id: string }> {
  const parsed = eventSchema.parse(input);
  const rows = await query<{ id: string }>(
    `INSERT INTO audit_governance.audit_events
       (trace_id, source_service, kind, subject_type, subject_id,
        actor_id, capability_id, tenant_id, severity, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     RETURNING id`,
    [
      parsed.trace_id ?? null,
      parsed.source_service,
      parsed.kind,
      parsed.subject_type ?? null,
      parsed.subject_id ?? null,
      parsed.actor_id ?? null,
      parsed.capability_id ?? null,
      parsed.tenant_id ?? null,
      parsed.severity ?? "info",
      JSON.stringify(parsed.payload ?? {}),
    ],
  );
  const id = rows[0].id;

  // Inline denormalisations.
  if (parsed.kind === "llm.call.completed" && parsed.payload) {
    await denormaliseLlmCall(
      id, parsed.trace_id ?? null, parsed.capability_id ?? null,
      parsed.tenant_id ?? null, parsed.payload,
    );
  }
  if (parsed.kind === "authz.decision" && parsed.payload) {
    const az = authzDecisionSchema.safeParse(parsed.payload);
    if (az.success) {
      await query(
        `INSERT INTO audit_governance.authz_decisions
           (audit_event_id, trace_id, actor_id, resource_type, resource_id,
            action, decision, reason, decided_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id, parsed.trace_id ?? az.data.trace_id ?? null,
          az.data.actor_id, az.data.resource_type, az.data.resource_id ?? null,
          az.data.action, az.data.decision, az.data.reason ?? null,
          az.data.decided_by ?? null,
        ],
      );
    }
  }
  return { id };
}

eventsRouter.post("/", async (req: Request, res: Response) => {
  const out = await ingestOne(req.body);
  res.status(201).json(out);
});

eventsRouter.post("/batch", async (req: Request, res: Response) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (events.length === 0) return res.status(400).json({ error: "events[] required" });
  if (events.length > 500) return res.status(400).json({ error: "max 500 events per batch" });
  const out: Array<{ id: string }> = [];
  for (const e of events) out.push(await ingestOne(e));
  res.status(201).json({ ingested: out.length, ids: out.map((r) => r.id) });
});
