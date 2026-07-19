/**
 * claim-registry event-bus dispatcher — the M11.e delivery loop (copied from the
 * workgraph dispatcher pattern, adapted to this service's simpler outbox schema).
 *
 * One dedicated pg.Client LISTENs on `event_outbox_claim_registry`; on every
 * notification — or every 30s safety sweep — it drains PENDING outbox rows, fans
 * out to matching EventSubscriptions, and POSTs each delivery (HMAC-signed, the
 * exact scheme platform receivers verify — see dispatch-core round-trip test).
 * A delivery is retried up to 5 times across sweeps; the row goes PROCESSED once
 * no delivery for it remains retryable.
 *
 * publishEvent() in events.ts fires pg_notify after the insert (best-effort);
 * the sweep guarantees delivery even when the notify is lost.
 */
import pg from 'pg'
import { prisma } from './prisma'
import { buildSignedDelivery, matchesAny, shouldRetry, MAX_DELIVERY_TRIES } from './dispatch-core'

export const EVENT_CHANNEL = 'event_outbox_claim_registry'
const SWEEP_INTERVAL_MS = 30_000
const DELIVERY_TIMEOUT_MS = 5_000
const BATCH = 50

let listener: pg.Client | null = null
let sweepTimer: NodeJS.Timeout | null = null
let draining = false

async function deliverRow(row: { id: string; eventType: string; aggregateId: string; payload: unknown; traceId: string | null; createdAt: Date; tenantId: string | null }): Promise<boolean> {
  const subs = await prisma.eventSubscription.findMany({ where: { active: true } })
  const matching = subs.filter((s) => matchesAny(s.eventTypes, row.eventType))

  for (const sub of matching) {
    await prisma.eventDelivery.upsert({
      where: { outboxId_subscriptionId: { outboxId: row.id, subscriptionId: sub.id } },
      create: { outboxId: row.id, subscriptionId: sub.id, status: 'PENDING' },
      update: {},
    })
  }

  let anyStillPending = false
  for (const sub of matching) {
    const delivery = await prisma.eventDelivery.findUnique({
      where: { outboxId_subscriptionId: { outboxId: row.id, subscriptionId: sub.id } },
    })
    if (!delivery || delivery.status === 'DELIVERED' || delivery.status === 'FAILED') continue

    const { body, headers } = buildSignedDelivery(row, sub.secret ?? null, Date.now())
    let delivered = false
    let lastError: string | null = null
    try {
      const res = await fetch(sub.targetUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) })
      if (res.ok) delivered = true
      else lastError = `target returned HTTP ${res.status}`
    } catch (err) {
      lastError = (err as Error).message
    }

    const retryable = !delivered && shouldRetry(delivery.attempts)
    await prisma.eventDelivery.update({
      where: { id: delivery.id },
      data: {
        status: delivered ? 'DELIVERED' : retryable ? 'PENDING' : 'FAILED',
        attempts: { increment: 1 },
        lastError: delivered ? null : lastError,
      },
    })
    if (!delivered && retryable) anyStillPending = true
  }

  return !anyStillPending
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    const rows = await prisma.eventOutbox.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    })
    for (const row of rows) {
      try {
        const settled = await deliverRow(row)
        if (settled) await prisma.eventOutbox.update({ where: { id: row.id }, data: { status: 'PROCESSED' } })
      } catch (err) {
        console.warn(`[dispatcher] row ${row.id} failed:`, (err as Error).message)
      }
    }
  } catch (err) {
    console.warn('[dispatcher] sweep failed:', (err as Error).message)
  } finally {
    draining = false
  }
}

export async function startDispatcher(): Promise<void> {
  const url = process.env.DATABASE_URL_CLAIM_REGISTRY ?? process.env.DATABASE_URL
  if (!url) {
    console.warn('[dispatcher] no database url — dispatcher not started')
    return
  }
  listener = new pg.Client({ connectionString: url })
  listener.on('error', (err) => console.warn('[dispatcher] listener error:', err.message))
  await listener.connect()
  await listener.query(`LISTEN ${EVENT_CHANNEL}`)
  listener.on('notification', () => { void drain() })
  sweepTimer = setInterval(() => { void drain() }, SWEEP_INTERVAL_MS)
  await drain() // pick up anything that accumulated while the service was down
  console.log(`claim-registry dispatcher listening on ${EVENT_CHANNEL} (retry x${MAX_DELIVERY_TRIES}, sweep ${SWEEP_INTERVAL_MS / 1000}s)`)
}

export async function stopDispatcher(): Promise<void> {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
  if (listener) await listener.end().catch(() => undefined)
  listener = null
}
