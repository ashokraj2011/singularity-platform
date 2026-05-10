/**
 * M11.e — agent-runtime event-bus dispatcher.
 *
 * Mirrors the workgraph dispatcher: dedicated pg.Client LISTENs on
 * `event_outbox_agent_runtime`, drains pending outbox rows on every
 * notification or every 30s safety sweep, fans out to matching
 * subscriptions, POSTs each delivery with optional HMAC-SHA256 signing,
 * and tracks per-delivery state for at-least-once semantics.
 *
 * Pattern matching: "agent.template.*" matches "agent.template.created" but
 * NOT "agent.template.skill.added" (`*` is non-greedy on `.`).
 */

import pg from "pg";
import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { EVENT_CHANNEL } from "./publisher";

const SWEEP_INTERVAL_MS    = 30_000;
const MAX_DELIVERY_TRIES   = 5;
const DELIVERY_TIMEOUT_MS  = 5_000;

let listenerClient: pg.Client | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let inFlight = false;

function patternToRegex(pattern: string): RegExp {
  if (!pattern.includes("*")) return new RegExp(`^${pattern.replace(/\./g, "\\.")}$`);
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*");
  return new RegExp(`^${re}$`);
}

async function findMatchingSubscriptions(prisma: PrismaClient, eventName: string) {
  const subs = await prisma.eventSubscription.findMany({
    where: { isActive: true },
    select: { id: true, targetUrl: true, secret: true, eventPattern: true },
  });
  return subs
    .filter((s) => patternToRegex(s.eventPattern).test(eventName))
    .map(({ id, targetUrl, secret }) => ({ id, targetUrl, secret }));
}

async function deliverOne(
  prisma: PrismaClient,
  outboxId: string,
  subscriptionId: string,
  targetUrl: string,
  envelope: unknown,
  eventName: string,
  secret: string | null,
): Promise<void> {
  const body = JSON.stringify({ event_name: eventName, envelope });
  const headers: Record<string, string> = {
    "content-type":      "application/json",
    "x-event-name":      eventName,
    "x-event-outbox-id": outboxId,
  };
  if (secret) {
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    headers["x-event-signature"] = `sha256=${sig}`;
  }

  let status = "failed";
  let responseStatus: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(targetUrl, {
      method:  "POST",
      headers,
      body,
      signal:  AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    responseStatus = res.status;
    if (res.ok) status = "sent";
    else error = `target returned HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message;
  }

  const existing = await prisma.eventDelivery.findUnique({
    where: { outboxId_subscriptionId: { outboxId, subscriptionId } },
    select: { id: true, attempts: true },
  });
  if (!existing) return;

  const finalStatus =
    status === "sent" ? "sent"
    : (existing.attempts + 1) < MAX_DELIVERY_TRIES ? "queued"
    : "failed";

  await prisma.eventDelivery.update({
    where: { id: existing.id },
    data: {
      status:         finalStatus,
      attempts:       { increment: 1 },
      lastAttemptAt:  new Date(),
      lastError:      error,
      deliveredAt:    status === "sent" ? new Date() : null,
      responseStatus,
    },
  });
}

async function processOutboxRow(prisma: PrismaClient, outboxId: string): Promise<void> {
  const row = await prisma.eventOutbox.findUnique({ where: { id: outboxId } });
  if (!row || row.status === "dispatched") return;

  const subs = await findMatchingSubscriptions(prisma, row.eventName);
  for (const s of subs) {
    await prisma.eventDelivery.upsert({
      where:  { outboxId_subscriptionId: { outboxId: row.id, subscriptionId: s.id } },
      create: { outboxId: row.id, subscriptionId: s.id, status: "queued" },
      update: {},
    });
  }
  for (const s of subs) {
    const d = await prisma.eventDelivery.findUnique({
      where: { outboxId_subscriptionId: { outboxId: row.id, subscriptionId: s.id } },
    });
    if (!d || d.status === "sent" || d.status === "failed") continue;
    await deliverOne(prisma, row.id, s.id, s.targetUrl, row.envelope, row.eventName, s.secret);
  }
  const remaining = await prisma.eventDelivery.count({
    where: { outboxId: row.id, status: "queued" },
  });
  if (remaining === 0) {
    await prisma.eventOutbox.update({
      where: { id: row.id },
      data:  { status: "dispatched", lastAttemptAt: new Date(), attempts: { increment: 1 } },
    });
  }
}

async function sweep(prisma: PrismaClient): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const pending = await prisma.eventOutbox.findMany({
      where:   { status: "pending" },
      orderBy: { emittedAt: "asc" },
      take:    50,
      select:  { id: true },
    });
    for (const r of pending) {
      try { await processOutboxRow(prisma, r.id); }
      catch (err) {
        await prisma.eventOutbox.update({
          where: { id: r.id },
          data:  { lastError: (err as Error).message, lastAttemptAt: new Date() },
        }).catch(() => null);
      }
    }
  } finally {
    inFlight = false;
  }
}

export async function startEventDispatcher(prisma: PrismaClient): Promise<void> {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) {
    console.warn("[eventbus] DATABASE_URL not set; dispatcher disabled");
    return;
  }
  listenerClient = new pg.Client({ connectionString: dsn });
  await listenerClient.connect();
  await listenerClient.query(`LISTEN ${EVENT_CHANNEL}`);

  listenerClient.on("notification", async (msg) => {
    if (msg.channel !== EVENT_CHANNEL) return;
    const id = msg.payload;
    if (!id) return;
    try { await processOutboxRow(prisma, id); }
    catch (err) {
      console.warn("[eventbus] processOutboxRow failed:", (err as Error).message);
    }
  });
  listenerClient.on("error", (err) => {
    console.error("[eventbus] LISTEN client error:", err.message);
  });

  sweepTimer = setInterval(() => { void sweep(prisma); }, SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();
  void sweep(prisma);

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
