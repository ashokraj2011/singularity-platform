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
import { Router, NextFunction, Request, Response } from "express";
import { query } from "./db";
import { eventSchema, authzDecisionSchema } from "./types";
import { denormaliseLlmCall } from "./cost-worker";
import { boundedEnvInteger, boundedInteger } from "./env";
// M63 Slice D — pure-function risk classifier mapping (kind, severity)
// → low/medium/high/critical so the search UI can filter by blast radius
// independently of "did the call succeed."
import { classifyRisk } from "./risk-classifier";
// M63 Slice B — broadcast hook for SSE live-tail subscribers. No-op
// when nobody's connected; non-blocking otherwise (just enqueues onto
// each subscriber's bounded buffer).
import { broadcastAuditEvent } from "./routes-stream";
// M35.1 — the shared service-auth gate. It lives in its own module so that
// routes-stream can use it without importing this one back (see service-auth.ts
// for why that cycle is worth avoiding). Re-exported below because seven other
// routers import it from here.
import { requireServiceAuth } from "./service-auth";

export { requireServiceAuth };

export const eventsRouter = Router();

const RATE_LIMIT_WINDOW_MS = boundedEnvInteger("AUDIT_GOV_EVENT_RATE_WINDOW_MS", {
  defaultValue: 60_000,
  min: 1_000,
  max: 3_600_000,
});
const RATE_LIMIT_MAX = boundedEnvInteger("AUDIT_GOV_EVENT_RATE_MAX", {
  defaultValue: 2_000,
  min: 1,
  max: 100_000,
});
const EVENT_BATCH_MAX = boundedEnvInteger("AUDIT_GOV_EVENT_BATCH_MAX", {
  defaultValue: 500,
  min: 1,
  max: 5_000,
});

// Per-source ceiling override. One global limit cannot fit both a service that
// emits a handful of governance decisions an hour and one that emits a row per
// LLM call — the llm-gateway emitter is the latter, and embeddings are the
// highest-volume traffic on the platform, so a shared 2k/min would throttle it
// the moment it is switched on. Batching does not dodge the limit either:
// weight counts as events.length below, by design.
//
// Format: JSON object of source_service → max events per window, e.g.
//   AUDIT_GOV_EVENT_RATE_MAX_BY_SOURCE='{"llm-gateway":20000}'
// Each value goes through the same bounds as the global limit, so a typo'd or
// hostile entry cannot disable rate limiting; malformed JSON falls back to the
// global limit for every source rather than failing boot.
export function parseRateMaxBySource(
  raw: string | undefined,
  fallback: number,
): Record<string, number> {
  if (!raw || !raw.trim()) return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[audit-gov] AUDIT_GOV_EVENT_RATE_MAX_BY_SOURCE is not valid JSON; ignoring");
    return {};
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    // eslint-disable-next-line no-console
    console.warn("[audit-gov] AUDIT_GOV_EVENT_RATE_MAX_BY_SOURCE must be a JSON object; ignoring");
    return {};
  }
  const out: Record<string, number> = {};
  for (const [source, value] of Object.entries(decoded as Record<string, unknown>)) {
    if (!source.trim()) continue;
    if (typeof value !== "string" && typeof value !== "number") continue;
    // Same bounds as AUDIT_GOV_EVENT_RATE_MAX. An out-of-range or unparseable
    // value falls back to the global limit for that source — never to
    // "unlimited", which is what a raw Number() would have given for a typo.
    out[source.trim()] = boundedInteger(value, {
      defaultValue: fallback,
      min: 1,
      max: 100_000,
    });
  }
  return out;
}

const RATE_LIMIT_MAX_BY_SOURCE = parseRateMaxBySource(
  process.env.AUDIT_GOV_EVENT_RATE_MAX_BY_SOURCE,
  RATE_LIMIT_MAX,
);

export function rateLimitMaxFor(source: string): number {
  return RATE_LIMIT_MAX_BY_SOURCE[source] ?? RATE_LIMIT_MAX;
}

const buckets = new Map<string, { resetAt: number; count: number }>();

// M35.1 — known source services. Events with `source_service` outside this
// allowlist are rejected so a compromised service can't claim a different
// identity. Empty list (default) disables the check (backwards compat); set
// AUDIT_GOV_ALLOWED_SOURCE_SERVICES to lock it down per environment.
const ALLOWED_SOURCE_SERVICES = (process.env.AUDIT_GOV_ALLOWED_SOURCE_SERVICES ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function sourceOf(req: Request): string {
  return typeof req.body?.source_service === "string"
    ? req.body.source_service
    : Array.isArray(req.body?.events) && typeof req.body.events[0]?.source_service === "string"
      ? req.body.events[0].source_service
      : "unknown";
}

function actorKey(req: Request): string {
  const source = sourceOf(req);
  const tenant = typeof req.body?.tenant_id === "string"
    ? req.body.tenant_id
    : Array.isArray(req.body?.events) && typeof req.body.events[0]?.tenant_id === "string"
      ? req.body.events[0].tenant_id
      : "global";
  return `${req.ip}:${source}:${tenant}`;
}

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const key = actorKey(req);
  const limit = rateLimitMaxFor(sourceOf(req));
  const current = buckets.get(key);
  const weight = Array.isArray(req.body?.events) ? req.body.events.length : 1;
  if (!current || current.resetAt <= now) {
    buckets.set(key, { resetAt: now + RATE_LIMIT_WINDOW_MS, count: weight });
    next();
    return;
  }
  if (current.count + weight > limit) {
    res.status(429).json({
      error: "rate_limited",
      limit,
      window_ms: RATE_LIMIT_WINDOW_MS,
      retry_after_ms: current.resetAt - now,
    });
    return;
  }
  current.count += weight;
  next();
}

eventsRouter.use(requireServiceAuth, rateLimit);

async function ingestOne(input: unknown): Promise<{ id: string }> {
  const parsed = eventSchema.parse(input);

  // M35.1 — source_service allowlist. When configured, reject events that
  // claim an identity outside the allowlist. Empty allowlist = no check.
  // Per-service tokens (so different services can't impersonate each other
  // even when both pass the gate) are out of scope for M35.1; tracked in M36.
  if (ALLOWED_SOURCE_SERVICES.length > 0 && !ALLOWED_SOURCE_SERVICES.includes(parsed.source_service)) {
    throw Object.assign(new Error(`source_service '${parsed.source_service}' is not in AUDIT_GOV_ALLOWED_SOURCE_SERVICES`), { status: 403 });
  }

  // M63 Slice D — Classify risk at ingest. Pure function, no I/O.
  const riskLevel = classifyRisk({
    kind: parsed.kind,
    severity: parsed.severity,
    payload: parsed.payload ?? null,
  });

  const rows = await query<{ id: string }>(
    `INSERT INTO audit_governance.audit_events
       (trace_id, source_service, kind, subject_type, subject_id,
        actor_id, capability_id, tenant_id, severity, risk_level, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
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
      riskLevel,
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

  // M63 Slice B — Push to SSE subscribers. Synchronous + non-blocking
  // (subscribers' bounded queue absorbs the write). created_at on the
  // emitted event is approximate; the canonical timestamp lives on the
  // DB row but the broadcast doesn't re-read it to keep ingest fast.
  broadcastAuditEvent({
    id,
    trace_id: parsed.trace_id ?? null,
    source_service: parsed.source_service,
    kind: parsed.kind,
    subject_type: parsed.subject_type ?? null,
    subject_id: parsed.subject_id ?? null,
    actor_id: parsed.actor_id ?? null,
    capability_id: parsed.capability_id ?? null,
    tenant_id: parsed.tenant_id ?? null,
    severity: parsed.severity ?? "info",
    risk_level: riskLevel,
    payload: parsed.payload ?? {},
    created_at: new Date().toISOString(),
  });

  return { id };
}

eventsRouter.post("/", async (req: Request, res: Response) => {
  const out = await ingestOne(req.body);
  res.status(201).json(out);
});

eventsRouter.post("/batch", async (req: Request, res: Response) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (events.length === 0) return res.status(400).json({ error: "events[] required" });
  if (events.length > EVENT_BATCH_MAX) {
    return res.status(400).json({ error: `max ${EVENT_BATCH_MAX} events per batch`, max_batch: EVENT_BATCH_MAX });
  }
  const out: Array<{ id: string }> = [];
  for (const e of events) out.push(await ingestOne(e));
  res.status(201).json({ ingested: out.length, ids: out.map((r) => r.id) });
});
