/**
 * M11.e — event-bus dispatcher.
 *
 * One dedicated `pg.Client` LISTENs on `event_outbox_workgraph`. On every
 * notification (or every 30s safety sweep) we drain pending outbox rows,
 * fan out to matching subscriptions, and POST each delivery via fetch.
 *
 * Pattern matching: subscriber stores a glob like "agent.run.*" or "*". A
 * literal match without `*` is exact; otherwise `.` is a literal and `*` is
 * `[^.]*` (does not cross dots) so `agent.run.*` matches `agent.run.completed`
 * but not `agent.run.tool.invocation.completed`.
 *
 * Retry policy: a delivery row is retried up to 5 times with exponential
 * backoff (the dispatcher only redrives on the next sweep — no in-process
 * scheduler). After 5 attempts the delivery is marked `failed` and ignored.
 */

import pg from 'pg'
import crypto from 'node:crypto'
import { prisma } from '../prisma'
import { config } from '../../config'
import { EVENT_CHANNEL } from './publisher'
import { assertEventTargetUrlAllowed } from './target-url-policy'
import { openSubscriptionSecret, sealSubscriptionSecret } from './subscription-secret'

const SWEEP_INTERVAL_MS  = 30_000
const MAX_DELIVERY_TRIES = 5
const DELIVERY_TIMEOUT_MS = 5_000

let listenerClient: pg.Client | null = null
let sweepTimer: NodeJS.Timeout | null = null
let inFlight = false

export async function migrateLegacySubscriptionSecrets(): Promise<number> {
  let migrated = 0
  while (true) {
    const rows = await prisma.$queryRaw<Array<{ id: string; secret: string }>>`
      SELECT id, secret
        FROM "event_subscriptions"
       WHERE secret IS NOT NULL
         AND secret NOT LIKE 'enc:v1:%'
       ORDER BY "createdAt" ASC
       LIMIT 500
    `
    if (rows.length === 0) break
    for (const row of rows) {
      await prisma.eventSubscription.update({
        where: { id: row.id },
        data: { secret: sealSubscriptionSecret(row.secret) },
      })
      migrated += 1
    }
  }
  return migrated
}

function logSweepFailure(err: unknown): void {
  console.warn('[eventbus] sweep failed:', (err as Error).message)
}

function patternToRegex(pattern: string): RegExp {
  if (!pattern.includes('*')) return new RegExp(`^${pattern.replace(/\./g, '\\.')}$`)
  // `.` is literal; `*` matches anything that isn't a `.`. Anchored.
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^.]*')
  return new RegExp(`^${re}$`)
}

async function findMatchingSubscriptions(eventName: string, tenantId: string | null): Promise<Array<{ id: string; targetUrl: string; secret: string | null }>> {
  const tenantScope = tenantId
    ? { tenantId }
    : config.TENANT_ISOLATION_MODE === 'strict'
      ? { tenantId: null }
      : {}
  const subs = await prisma.eventSubscription.findMany({
    where: { isActive: true, ...tenantScope },
    select: { id: true, targetUrl: true, secret: true, eventPattern: true },
  })
  return subs
    .filter((s) => patternToRegex(s.eventPattern).test(eventName))
    .map(({ id, targetUrl, secret }) => ({ id, targetUrl, secret: openSubscriptionSecret(secret) }))
}

async function deliverOne(
  outboxId: string,
  subscriptionId: string,
  targetUrl: string,
  envelope: unknown,
  eventName: string,
  secret: string | null,
): Promise<void> {
  const body = JSON.stringify({ event_name: eventName, envelope })
  const headers: Record<string, string> = {
    'content-type':       'application/json',
    'x-event-name':       eventName,
    'x-event-outbox-id':  outboxId,
  }
  if (secret) {
    const timestamp = String(Date.now())
    headers['x-event-timestamp'] = timestamp
    const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    headers['x-event-signature'] = `sha256=${sig}`
  }

  let status = 'failed'
  let responseStatus: number | null = null
  let error: string | null = null
  try {
    const safeUrl = await assertEventTargetUrlAllowed(targetUrl)
    const res = await fetch(safeUrl, {
      method:  'POST',
      headers,
      body,
      signal:  AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    })
    responseStatus = res.status
    if (res.ok) status = 'sent'
    else error = `target returned HTTP ${res.status}`
  } catch (err) {
    error = (err as Error).message
  }

  await prisma.eventDelivery.update({
    where: { id: (await prisma.eventDelivery.findUnique({
      where: { outboxId_subscriptionId: { outboxId, subscriptionId } },
      select: { id: true },
    }))!.id },
    data: {
      status:         status === 'sent' ? 'sent' : (await shouldRetry(outboxId, subscriptionId)) ? 'queued' : 'failed',
      attempts:       { increment: 1 },
      lastAttemptAt:  new Date(),
      lastError:      error,
      deliveredAt:    status === 'sent' ? new Date() : null,
      responseStatus,
    },
  })
}

async function shouldRetry(outboxId: string, subscriptionId: string): Promise<boolean> {
  const d = await prisma.eventDelivery.findUnique({
    where: { outboxId_subscriptionId: { outboxId, subscriptionId } },
    select: { attempts: true },
  })
  return (d?.attempts ?? 0) + 1 < MAX_DELIVERY_TRIES
}

async function processOutboxRow(outboxId: string): Promise<void> {
  const row = await prisma.eventOutbox.findUnique({ where: { id: outboxId } })
  if (!row || row.status === 'dispatched' || row.status === 'failed') return

  const subs = await findMatchingSubscriptions(row.eventName, row.tenantId)
  // Create delivery rows (idempotent via unique [outboxId, subscriptionId]).
  for (const s of subs) {
    await prisma.eventDelivery.upsert({
      where:  { outboxId_subscriptionId: { outboxId: row.id, subscriptionId: s.id } },
      create: { outboxId: row.id, subscriptionId: s.id, status: 'queued' },
      update: {},
    })
  }

  // Drive each delivery.
  for (const s of subs) {
    const d = await prisma.eventDelivery.findUnique({
      where: { outboxId_subscriptionId: { outboxId: row.id, subscriptionId: s.id } },
    })
    if (!d || d.status === 'sent' || d.status === 'failed') continue
    await deliverOne(row.id, s.id, s.targetUrl, row.envelope, row.eventName, s.secret)
  }

  // If every delivery for this row is sent or failed, close the outbox row.
  // A single failed subscriber keeps the aggregate outbox health failed until
  // an operator retries the delivery, instead of hiding it behind "dispatched".
  const remaining = await prisma.eventDelivery.count({
    where: { outboxId: row.id, status: 'queued' },
  })
  if (remaining === 0) {
    const failed = await prisma.eventDelivery.count({
      where: { outboxId: row.id, status: 'failed' },
    })
    await prisma.eventOutbox.update({
      where: { id: row.id },
      data:  {
        status: failed > 0 ? 'failed' : 'dispatched',
        lastAttemptAt: new Date(),
        attempts: { increment: 1 },
        lastError: failed > 0 ? `${failed} event delivery subscriber(s) failed` : null,
      },
    })
  }
}

async function sweep(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const pending = await prisma.eventOutbox.findMany({
      where:   { status: 'pending' },
      orderBy: { emittedAt: 'asc' },
      take:    50,
      select:  { id: true },
    })
    for (const r of pending) {
      try { await processOutboxRow(r.id) }
      catch (err) {
        await prisma.eventOutbox.update({
          where: { id: r.id },
          data:  { lastError: (err as Error).message, lastAttemptAt: new Date() },
        }).catch(() => null)
      }
    }
  } finally {
    inFlight = false
  }
}

export async function startEventDispatcher(): Promise<void> {
  const migrated = await migrateLegacySubscriptionSecrets()
  if (migrated > 0) console.log(`[eventbus] encrypted ${migrated} legacy event-subscription secret(s)`)
  // Dedicated client so LISTEN doesn't get returned to a pool.
  listenerClient = new pg.Client({ connectionString: config.DATABASE_URL })
  await listenerClient.connect()
  await listenerClient.query(`LISTEN ${EVENT_CHANNEL}`)

  listenerClient.on('notification', async (msg) => {
    if (msg.channel !== EVENT_CHANNEL) return
    const id = msg.payload
    if (!id) return
    try { await processOutboxRow(id) }
    catch (err) {
      console.warn('[eventbus] processOutboxRow failed:', (err as Error).message)
    }
  })

  listenerClient.on('error', (err) => {
    console.error('[eventbus] LISTEN client error:', err.message)
  })

  // Safety sweep — catches anything missed (NOTIFY before LISTEN, restarts).
  sweepTimer = setInterval(() => { void sweep().catch(logSweepFailure) }, SWEEP_INTERVAL_MS)
  if (sweepTimer.unref) sweepTimer.unref()

  // Drain anything already pending at startup.
  void sweep().catch(logSweepFailure)

  console.log(`[eventbus] dispatcher listening on '${EVENT_CHANNEL}'; safety sweep every ${SWEEP_INTERVAL_MS / 1000}s`)
}

export async function stopEventDispatcher(): Promise<void> {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
  if (listenerClient) {
    try { await listenerClient.end() } catch { /* ignore */ }
    listenerClient = null
  }
}
