/**
 * M11.e — tool-service event-bus dispatcher.
 *
 * Same pattern as workgraph + agent-runtime, but using raw pg (no Prisma).
 * Dedicated pg.Client LISTENs on `event_outbox_agent_service`, drains on
 * notification or every 30s safety sweep, fans out to matching subs,
 * POSTs each delivery with optional HMAC signing, tracks per-delivery
 * state for at-least-once semantics with 5-attempt exponential retry.
 */
import { Client } from "pg";
import crypto from "node:crypto";
import { pool } from "../../database";
import { EVENT_CHANNEL } from "./publisher";

const SWEEP_INTERVAL_MS    = 30_000;
const MAX_DELIVERY_TRIES   = 5;
const DELIVERY_TIMEOUT_MS  = 5_000;

let listenerClient: Client | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let inFlight = false;

function patternToRegex(pattern: string): RegExp {
  if (!pattern.includes("*")) return new RegExp(`^${pattern.replace(/\./g, "\\.")}$`);
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*");
  return new RegExp(`^${re}$`);
}

interface SubRow { id: string; target_url: string; secret: string | null; event_pattern: string }

async function findMatchingSubscriptions(eventName: string): Promise<SubRow[]> {
  const { rows } = await pool.query<SubRow>(
    `SELECT id, target_url, secret, event_pattern
     FROM agent.event_subscriptions WHERE is_active = true`,
  );
  return rows.filter((s) => patternToRegex(s.event_pattern).test(eventName));
}

async function deliverOne(
  outboxId: string, subscriptionId: string, targetUrl: string,
  envelope: unknown, eventName: string, secret: string | null,
): Promise<void> {
  const body = JSON.stringify({ event_name: eventName, envelope });
  const headers: Record<string, string> = {
    "content-type":      "application/json",
    "x-event-name":      eventName,
    "x-event-outbox-id": outboxId,
  };
  if (secret) {
    headers["x-event-signature"] = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  }

  let status = "failed";
  let responseStatus: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(targetUrl, {
      method: "POST", headers, body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    responseStatus = res.status;
    if (res.ok) status = "sent";
    else error = `target returned HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message;
  }

  const cur = await pool.query<{ attempts: number }>(
    `SELECT attempts FROM agent.event_deliveries WHERE outbox_id = $1 AND subscription_id = $2`,
    [outboxId, subscriptionId],
  );
  if (cur.rows.length === 0) return;
  const finalStatus =
    status === "sent" ? "sent"
    : (cur.rows[0].attempts + 1) < MAX_DELIVERY_TRIES ? "queued"
    : "failed";

  await pool.query(
    `UPDATE agent.event_deliveries
     SET status = $3, attempts = attempts + 1, last_attempt_at = now(),
         last_error = $4, delivered_at = $5, response_status = $6
     WHERE outbox_id = $1 AND subscription_id = $2`,
    [outboxId, subscriptionId, finalStatus, error,
     status === "sent" ? new Date() : null, responseStatus],
  );
}

async function processOutboxRow(outboxId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, event_name, envelope, status FROM agent.event_outbox WHERE id = $1`,
    [outboxId],
  );
  if (rows.length === 0 || rows[0].status === "dispatched") return;
  const row = rows[0];

  const subs = await findMatchingSubscriptions(row.event_name);
  for (const s of subs) {
    await pool.query(
      `INSERT INTO agent.event_deliveries (outbox_id, subscription_id, status)
       VALUES ($1, $2, 'queued')
       ON CONFLICT (outbox_id, subscription_id) DO NOTHING`,
      [row.id, s.id],
    );
  }
  for (const s of subs) {
    const cur = await pool.query<{ status: string }>(
      `SELECT status FROM agent.event_deliveries WHERE outbox_id = $1 AND subscription_id = $2`,
      [row.id, s.id],
    );
    if (cur.rows.length === 0 || cur.rows[0].status === "sent" || cur.rows[0].status === "failed") continue;
    await deliverOne(row.id, s.id, s.target_url, row.envelope, row.event_name, s.secret);
  }
  const remaining = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM agent.event_deliveries WHERE outbox_id = $1 AND status = 'queued'`,
    [row.id],
  );
  if (Number(remaining.rows[0].c) === 0) {
    await pool.query(
      `UPDATE agent.event_outbox
       SET status = 'dispatched', last_attempt_at = now(), attempts = attempts + 1
       WHERE id = $1`,
      [row.id],
    );
  }
}

async function sweep(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent.event_outbox WHERE status = 'pending'
       ORDER BY emitted_at ASC LIMIT 50`,
    );
    for (const r of rows) {
      try { await processOutboxRow(r.id); }
      catch (err) {
        await pool.query(
          `UPDATE agent.event_outbox SET last_error = $2, last_attempt_at = now() WHERE id = $1`,
          [r.id, (err as Error).message],
        ).catch(() => null);
      }
    }
  } finally { inFlight = false; }
}

export async function startEventDispatcher(): Promise<void> {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) {
    console.warn("[eventbus] DATABASE_URL not set; dispatcher disabled");
    return;
  }
  listenerClient = new Client({ connectionString: dsn });
  await listenerClient.connect();
  await listenerClient.query(`LISTEN ${EVENT_CHANNEL}`);

  listenerClient.on("notification", async (msg) => {
    if (msg.channel !== EVENT_CHANNEL || !msg.payload) return;
    try { await processOutboxRow(msg.payload); }
    catch (err) { console.warn("[eventbus] processOutboxRow failed:", (err as Error).message); }
  });
  listenerClient.on("error", (err) => {
    console.error("[eventbus] LISTEN client error:", err.message);
  });

  sweepTimer = setInterval(() => { void sweep(); }, SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();
  void sweep();

  console.log(`[eventbus] dispatcher listening on '${EVENT_CHANNEL}'; safety sweep every ${SWEEP_INTERVAL_MS / 1000}s`);
}

export async function stopEventDispatcher(): Promise<void> {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  if (listenerClient) {
    try { await listenerClient.end(); } catch { /* ignore */ }
    listenerClient = null;
  }
}
