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
import { timingSafeEqual } from "node:crypto";
import { query } from "./db";
import { eventSchema, authzDecisionSchema } from "./types";
import { denormaliseLlmCall } from "./cost-worker";

export const eventsRouter = Router();

const SERVICE_TOKEN = process.env.AUDIT_GOV_SERVICE_TOKEN ?? "";
// M35.1 — anonymous mode is OPT-IN only. Previously it auto-enabled when
// SERVICE_TOKEN was unset in non-production NODE_ENV; that silently allowed
// unauthenticated event ingest whenever someone forgot to set the env var.
// Now you MUST explicitly set AUDIT_GOV_ALLOW_ANONYMOUS_DEV=1 to allow it.
const ALLOW_ANON_DEV = process.env.AUDIT_GOV_ALLOW_ANONYMOUS_DEV === "1";
const RATE_LIMIT_WINDOW_MS = Number(process.env.AUDIT_GOV_EVENT_RATE_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.AUDIT_GOV_EVENT_RATE_MAX ?? 2_000);
const buckets = new Map<string, { resetAt: number; count: number }>();

// M35.1 — known source services. Events with `source_service` outside this
// allowlist are rejected so a compromised service can't claim a different
// identity. Empty list (default) disables the check (backwards compat); set
// AUDIT_GOV_ALLOWED_SOURCE_SERVICES to lock it down per environment.
const ALLOWED_SOURCE_SERVICES = (process.env.AUDIT_GOV_ALLOWED_SOURCE_SERVICES ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function actorKey(req: Request): string {
  const source = typeof req.body?.source_service === "string"
    ? req.body.source_service
    : Array.isArray(req.body?.events) && typeof req.body.events[0]?.source_service === "string"
      ? req.body.events[0].source_service
      : "unknown";
  const tenant = typeof req.body?.tenant_id === "string"
    ? req.body.tenant_id
    : Array.isArray(req.body?.events) && typeof req.body.events[0]?.tenant_id === "string"
      ? req.body.events[0].tenant_id
      : "global";
  return `${req.ip}:${source}:${tenant}`;
}

// M35.1 — exported so the engine router (engine/routes.ts) can apply the same
// auth contract to its mutation endpoints.
export function requireServiceAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7)
    : String(req.headers["x-service-token"] ?? "");
  if (SERVICE_TOKEN) {
    // Constant-time compare to close a timing side-channel on the token.
    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(SERVICE_TOKEN, "utf8");
    const lenOk = a.length === b.length;
    const eq = lenOk ? timingSafeEqual(a, b) : (timingSafeEqual(b, Buffer.alloc(b.length)), false);
    if (!eq) {
      res.status(401).json({ error: "invalid service token" });
      return;
    }
    next();
    return;
  }
  if (!ALLOW_ANON_DEV) {
    res.status(503).json({ error: "AUDIT_GOV_SERVICE_TOKEN is required" });
    return;
  }
  next();
}

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const key = actorKey(req);
  const current = buckets.get(key);
  const weight = Array.isArray(req.body?.events) ? req.body.events.length : 1;
  if (!current || current.resetAt <= now) {
    buckets.set(key, { resetAt: now + RATE_LIMIT_WINDOW_MS, count: weight });
    next();
    return;
  }
  if (current.count + weight > RATE_LIMIT_MAX) {
    res.status(429).json({
      error: "rate_limited",
      limit: RATE_LIMIT_MAX,
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
