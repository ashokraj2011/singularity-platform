/**
 * M63 Slice B — Server-Sent Events live-tail.
 *
 *   GET /api/v1/audit/stream?kinds=…&severities=…&riskLevels=…&capabilityId=…
 *
 * Operator subscribes via EventSource; the server pushes every NEW
 * audit_events row (after subscription time) that matches the filter.
 * Used by the Splunk-like UI's "Live tail" toggle.
 *
 * Architecture:
 *   - Single in-process Set<Subscriber> on this service instance.
 *   - Event ingest (routes-events.ts) calls broadcast(event) AFTER
 *     a successful INSERT. We don't depend on the DB's LISTEN/NOTIFY
 *     because the ingest already holds the row in memory.
 *   - SSE clients send keep-alive comments every 15s to defeat proxy
 *     idle timeouts (HAProxy/nginx default ~60s).
 *   - Backpressure: per-subscriber write queue is bounded; on overflow
 *     we drop the slowest client. The UI auto-reconnects on stream
 *     close, so a brief blip is recoverable.
 *
 * Capacity: capped at 50 concurrent subscribers per instance. New
 * connections beyond the cap get 503 + Retry-After hint. The cap
 * defends a small in-process service against accidental fan-out from
 * a runaway UI bug.
 */
import { Router, Request, Response } from "express";
import { boundedEnvInteger } from "./env";
import { requireServiceAuth } from "./routes-events";

const MAX_SUBSCRIBERS = boundedEnvInteger("AUDIT_GOV_STREAM_MAX_SUBSCRIBERS", {
  defaultValue: 50,
  min: 1,
  max: 1_000,
});
const KEEPALIVE_INTERVAL_MS = boundedEnvInteger("AUDIT_GOV_STREAM_KEEPALIVE_MS", {
  defaultValue: 15_000,
  min: 1_000,
  max: 300_000,
});
const PER_CLIENT_QUEUE_MAX = boundedEnvInteger("AUDIT_GOV_STREAM_QUEUE_MAX", {
  defaultValue: 500,
  min: 1,
  max: 10_000,
});

export type AuditEventRow = {
  id: string;
  trace_id: string | null;
  source_service: string;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  actor_id: string | null;
  capability_id: string | null;
  tenant_id: string | null;
  severity: string;
  risk_level: string | null;
  payload: Record<string, unknown>;
  created_at: Date | string;
};

type Filter = {
  kinds?: Set<string>;
  severities?: Set<string>;
  riskLevels?: Set<string>;
  sources?: Set<string>;
  capabilityId?: string;
  actorId?: string;
  traceId?: string;
};

type Subscriber = {
  id: string;
  res: Response;
  filter: Filter;
  // Bounded write queue. Each entry is one already-serialised SSE frame.
  queue: string[];
  closed: boolean;
  droppedCount: number;
};

const subscribers = new Set<Subscriber>();

function matches(ev: AuditEventRow, f: Filter): boolean {
  if (f.kinds && !f.kinds.has(ev.kind)) return false;
  if (f.severities && !f.severities.has(ev.severity)) return false;
  if (f.riskLevels && (ev.risk_level === null || !f.riskLevels.has(ev.risk_level))) return false;
  if (f.sources && !f.sources.has(ev.source_service)) return false;
  if (f.capabilityId && ev.capability_id !== f.capabilityId) return false;
  if (f.actorId && ev.actor_id !== f.actorId) return false;
  if (f.traceId && ev.trace_id !== f.traceId) return false;
  return true;
}

function serialize(ev: AuditEventRow): string {
  // SSE frame format: id + event + data + blank line.
  // The `id` field lets the client resume via Last-Event-ID on reconnect
  // (the UI sends it and we honour it via a Postgres "events newer than X"
  // catch-up query — left as a follow-up; today reconnect starts fresh).
  const created = ev.created_at instanceof Date ? ev.created_at.toISOString() : String(ev.created_at);
  const payload = JSON.stringify({
    id: ev.id,
    trace_id: ev.trace_id,
    source_service: ev.source_service,
    kind: ev.kind,
    subject_type: ev.subject_type,
    subject_id: ev.subject_id,
    actor_id: ev.actor_id,
    capability_id: ev.capability_id,
    tenant_id: ev.tenant_id,
    severity: ev.severity,
    risk_level: ev.risk_level,
    payload: ev.payload,
    created_at: created,
  });
  return `id: ${ev.id}\nevent: audit\ndata: ${payload}\n\n`;
}

function pump(sub: Subscriber): void {
  // Flush the queue. Best-effort: if .write() returns false we still
  // continue — Node buffers internally and the next pump call will
  // catch up.
  while (sub.queue.length > 0 && !sub.closed) {
    const frame = sub.queue.shift()!;
    try {
      sub.res.write(frame);
    } catch {
      sub.closed = true;
      break;
    }
  }
}

/**
 * Public broadcast hook. Called from routes-events.ts inside ingestOne
 * after the INSERT succeeds. Synchronous (just enqueues onto each
 * subscriber's bounded buffer; the per-subscriber pump drains it).
 */
export function broadcastAuditEvent(ev: AuditEventRow): void {
  if (subscribers.size === 0) return;
  let frame: string | null = null;
  for (const sub of subscribers) {
    if (sub.closed) continue;
    if (!matches(ev, sub.filter)) continue;
    if (sub.queue.length >= PER_CLIENT_QUEUE_MAX) {
      // Backpressure: drop oldest. The UI's heartbeat detects the drop
      // and the operator can re-run the search to backfill missed rows.
      sub.queue.shift();
      sub.droppedCount += 1;
    }
    if (!frame) frame = serialize(ev);
    sub.queue.push(frame);
    pump(sub);
  }
}

// ── HTTP surface ────────────────────────────────────────────────────────────

export const streamRouter = Router();

// P0 part 2 — /audit/stream is service-token gated. The proxy layer supplies the token: the
// blueprint-workbench cockpit + Loop Theater reach it via their dev-Vite / prod-nginx /audit-gov
// proxy (which injects AUDIT_GOV_TOKEN), and agent-and-tools via its server proxy route. The
// EventSource the browser opens carries no credential of its own — the proxy adds it.
streamRouter.use(requireServiceAuth);

function parseSet(raw: unknown): Set<string> | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return new Set(parts);
}

function parseStr(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

streamRouter.get("/audit/stream", (req: Request, res: Response) => {
  if (subscribers.size >= MAX_SUBSCRIBERS) {
    res.set("Retry-After", "30");
    res.status(503).json({
      error: "stream_capacity_exceeded",
      max_subscribers: MAX_SUBSCRIBERS,
      current_subscribers: subscribers.size,
    });
    return;
  }

  // SSE response headers. text/event-stream + no-cache + keep-alive
  // is the EventSource contract.
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // defeat nginx response buffering
  });
  res.flushHeaders();

  const filter: Filter = {
    kinds: parseSet(req.query.kinds),
    severities: parseSet(req.query.severities),
    riskLevels: parseSet(req.query.riskLevels),
    sources: parseSet(req.query.sources),
    capabilityId: parseStr(req.query.capabilityId),
    actorId: parseStr(req.query.actorId),
    traceId: parseStr(req.query.traceId),
  };

  const sub: Subscriber = {
    id: `sub-${Math.random().toString(36).slice(2, 10)}`,
    res,
    filter,
    queue: [],
    closed: false,
    droppedCount: 0,
  };
  subscribers.add(sub);

  // Initial hello frame so the client can confirm the stream is live
  // before the first matching event arrives. EventSource fires
  // `onopen` on headers, but `onmessage` only fires on data — the
  // hello gives the UI something to render in the "connected" state.
  sub.res.write(`event: hello\ndata: ${JSON.stringify({ subscriberId: sub.id, filter: Array.from(Object.keys(filter)) })}\n\n`);

  // Heartbeat — SSE comment lines (`:`-prefixed) keep the connection
  // alive through idle-timeout proxies without showing up as a data event.
  const heartbeat = setInterval(() => {
    if (sub.closed) return;
    try {
      sub.res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      sub.closed = true;
    }
  }, KEEPALIVE_INTERVAL_MS);

  const cleanup = (): void => {
    sub.closed = true;
    clearInterval(heartbeat);
    subscribers.delete(sub);
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("error", cleanup);
});

// Operator-facing introspection — useful for "is anyone watching?"
streamRouter.get("/audit/stream/stats", (_req: Request, res: Response) => {
  let totalDropped = 0;
  let maxQueue = 0;
  for (const s of subscribers) {
    totalDropped += s.droppedCount;
    if (s.queue.length > maxQueue) maxQueue = s.queue.length;
  }
  res.json({
    subscribers: subscribers.size,
    max_subscribers: MAX_SUBSCRIBERS,
    total_dropped_events: totalDropped,
    max_pending_queue: maxQueue,
    keepalive_interval_ms: KEEPALIVE_INTERVAL_MS,
  });
});
