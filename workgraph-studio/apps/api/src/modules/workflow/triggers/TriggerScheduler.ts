import cron from 'node-cron'
import { prisma } from '../../../lib/prisma'
import { withTenantDbTransaction } from '../../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../../lib/audit'
import { createWorkItem } from '../../work-items/work-items.service'
import { routeWorkItem } from '../../work-items/work-item-routing.service'
import { normalizeMetadataKey, recordOf } from '../../metadata/metadata.service'
import { tenantIdForCreate } from '../../../lib/tenant-isolation'

const EVENT_LOOKBACK_CAP_MS = 24 * 60 * 60 * 1000
const EVENT_TRIGGER_BATCH_SIZE = 200
const EVENT_TRIGGER_MAX_SCAN = 2_000

const processedEventIds = new Set<string>()

function markEventProcessed(id: string) {
  processedEventIds.add(id)
  if (processedEventIds.size > 10000) {
    processedEventIds.clear()
  }
}

/**
 * SCHEDULE-type triggers fire instances on a cron expression. EVENT-type
 * triggers subscribe to OutboxEvent rows whose `eventType` matches their
 * config.eventType. Both are evaluated on a 30s tick.
 */
export function startTriggerScheduler(): void {
  cron.schedule('*/30 * * * * *', async () => {
    await runScheduledWorkItems()
    await runWorkItemScheduleTriggers()
    await runWorkItemEventTriggers()
    await runScheduleTriggers()
    await runEventTriggers()
  })
  console.log('Trigger scheduler started')
}

async function runScheduledWorkItems(): Promise<void> {
  try {
    const now = new Date()
    const items = await prisma.workItem.findMany({
      where: {
        status: 'SCHEDULED',
        routingMode: 'SCHEDULED_START',
        AND: [
          { OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] },
          { OR: [{ notBefore: null }, { notBefore: { lte: now } }] },
        ],
      },
      take: 25,
      orderBy: [{ scheduledAt: 'asc' }, { notBefore: 'asc' }],
    })
    for (const item of items) {
      await prisma.workItemEvent.create({
        data: {
          workItemId: item.id,
          eventType: 'TRIGGERED',
          payload: { trigger: 'server-time', firedAt: now.toISOString() } as object,
        },
      })
      await routeWorkItem(item.id, null, { routingMode: 'SCHEDULED_START', startNow: true })
    }
  } catch (err) {
    console.error('Scheduled WorkItem sweep error:', err)
  }
}

async function runWorkItemScheduleTriggers(): Promise<void> {
  try {
    const triggers = await prisma.workItemTrigger.findMany({
      where: { triggerType: 'SCHEDULE', isActive: true },
      orderBy: { createdAt: 'asc' },
    })
    const now = new Date()
    for (const trigger of triggers) {
      const cfg = recordOf(trigger.scheduleConfig)
      const cronExpr = typeof cfg.cron === 'string' ? cfg.cron : null
      const timezone = typeof cfg.timezone === 'string' ? cfg.timezone : undefined
      if (!trigger.capabilityId || !cronExpr || !cron.validate(cronExpr)) continue
      const lastFiredMs = trigger.lastFiredAt ? trigger.lastFiredAt.valueOf() : 0
      if (now.valueOf() - lastFiredMs < 60_000) continue
      if (!matchesCronNow(cronExpr, now, timezone)) continue

      const workItem = await createWorkItemFromTrigger(trigger, {
        title: String(cfg.title ?? `${trigger.workItemTypeKey} scheduled work`),
        description: typeof cfg.description === 'string' ? cfg.description : undefined,
        input: { triggerType: 'SCHEDULE', cron: cronExpr, timezone: timezone ?? 'server-local' },
      }, now)
      await prisma.workItemTrigger.update({ where: { id: trigger.id }, data: { lastFiredAt: now } })
      await routeWorkItem(workItem.id, null, { routingMode: trigger.routingMode })
    }
  } catch (err) {
    console.error('WorkItem schedule trigger error:', err)
  }
}

async function runWorkItemEventTriggers(): Promise<void> {
  try {
    const triggers = await prisma.workItemTrigger.findMany({
      where: { triggerType: 'EVENT', isActive: true },
      orderBy: { createdAt: 'asc' },
    })
    if (triggers.length === 0) return
    for (const trigger of triggers) {
      if (!trigger.capabilityId || !trigger.eventTypeKey) continue
      const mapping = recordOf(trigger.payloadMapping)
      const matchedEvents = await loadMatchingOutboxEvents({
        since: eventLookbackSince(trigger),
        lastFiredAt: trigger.lastFiredAt,
        matchesEventType: eventType => normalizeMetadataKey(eventType) === trigger.eventTypeKey,
        filter: mapping.filter,
      })

      for (const matched of matchedEvents) {
        const payload = recordOf(matched.payload)
        const title = stringAt(payload, mapping.titlePath) ?? String(mapping.title ?? `${trigger.workItemTypeKey} event work`)
        const description = stringAt(payload, mapping.descriptionPath) ?? (typeof mapping.description === 'string' ? mapping.description : undefined)
        const workItem = await createWorkItemFromTrigger(trigger, {
          title,
          description,
          input: { triggerType: 'EVENT', eventType: matched.eventType, payload },
          sourceEventTypeKey: matched.eventType,
        }, new Date())
        await prisma.workItemTrigger.update({
          where: { id: trigger.id },
          data: { lastFiredAt: matched.createdAt },
        })
        trigger.lastFiredAt = matched.createdAt
        markEventProcessed(matched.id)
        await routeWorkItem(workItem.id, null, { routingMode: trigger.routingMode })
      }
    }
  } catch (err) {
    console.error('WorkItem event trigger error:', err)
  }
}

async function createWorkItemFromTrigger(
  trigger: {
    id: string
    capabilityId: string | null
    workItemTypeKey: string
    routingMode: 'MANUAL' | 'AUTO_ATTACH' | 'AUTO_START' | 'SCHEDULED_START'
    eventTypeKey: string | null
    payloadMapping: unknown
  },
  seed: { title: string; description?: string; input: Record<string, unknown>; sourceEventTypeKey?: string },
  now: Date,
) {
  if (!trigger.capabilityId) throw new Error('WorkItem trigger requires capabilityId')
  const workItem = await createWorkItem({
    title: seed.title,
    description: seed.description,
    workItemTypeKey: trigger.workItemTypeKey,
    routingMode: trigger.routingMode,
    sourceEventTypeKey: seed.sourceEventTypeKey ?? trigger.eventTypeKey ?? undefined,
    parentCapabilityId: trigger.capabilityId,
    input: seed.input,
    details: {
      title: seed.title,
      description: seed.description ?? null,
      source: 'work-item-trigger',
      triggerId: trigger.id,
      firedAt: now.toISOString(),
      input: seed.input,
    },
    originType: 'CAPABILITY_LOCAL',
    targets: [{ targetCapabilityId: trigger.capabilityId }],
  }, null)
  await prisma.workItemEvent.create({
    data: {
      workItemId: workItem.id,
      eventType: 'TRIGGERED',
      payload: { triggerId: trigger.id, firedAt: now.toISOString() } as object,
    },
  })
  return workItem
}

function stringAt(root: Record<string, unknown>, rawPath: unknown): string | undefined {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return undefined
  const value = rawPath.split('.').filter(Boolean).reduce<unknown>((cur, key) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[key]
    return undefined
  }, root)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function runScheduleTriggers(): Promise<void> {
  try {
    const triggers = await prisma.workflowTrigger.findMany({
      where: { type: 'SCHEDULE', isActive: true },
      include: { template: true },
    })
    const now = new Date()
    for (const t of triggers) {
      const cfg = (t.config ?? {}) as Record<string, unknown>
      const cronExpr = typeof cfg.cron === 'string' ? cfg.cron : null
      const timezone = typeof cfg.timezone === 'string' ? cfg.timezone : undefined
      if (!cronExpr || !cron.validate(cronExpr)) continue

      // Simple "did we miss this minute?" — fire if last fire was >60s ago and
      // current minute matches the cron's next-tick window.
      const lastFiredMs = t.lastFiredAt ? t.lastFiredAt.valueOf() : 0
      if (now.valueOf() - lastFiredMs < 60_000) continue
      if (!matchesCronNow(cronExpr, now, timezone)) continue

      await spawnInstance(t.id, t.templateId, t.template.name, {
        _triggeredAt: now.toISOString(),
        _trigger: { type: 'SCHEDULE', cron: cronExpr, timezone: timezone ?? 'server-local' },
      })
      await prisma.workflowTrigger.update({
        where: { id: t.id },
        data: { lastFiredAt: now },
      })
    }
  } catch (err) {
    console.error('Schedule trigger error:', err)
  }
}

async function runEventTriggers(): Promise<void> {
  try {
    const triggers = await prisma.workflowTrigger.findMany({
      where: { type: 'EVENT', isActive: true },
      include: { template: true },
    })
    if (triggers.length === 0) return

    for (const t of triggers) {
      const cfg = (t.config ?? {}) as Record<string, unknown>
      const wantedType = typeof cfg.eventType === 'string' ? cfg.eventType : null
      if (!wantedType) continue

      const matchedEvents = await loadMatchingOutboxEvents({
        since: eventLookbackSince(t),
        lastFiredAt: t.lastFiredAt,
        matchesEventType: eventType => eventType === wantedType,
        filter: cfg.filter,
      })

      for (const matched of matchedEvents) {
        await spawnInstance(t.id, t.templateId, t.template.name, {
          _triggeredAt: matched.createdAt.toISOString(),
          _triggerEvent: { type: matched.eventType, payload: matched.payload },
        })
        await prisma.workflowTrigger.update({
          where: { id: t.id },
          data: { lastFiredAt: matched.createdAt },
        })
        t.lastFiredAt = matched.createdAt
        markEventProcessed(matched.id)
      }
    }
  } catch (err) {
    console.error('Event trigger error:', err)
  }
}

function eventLookbackSince(trigger: { lastFiredAt: Date | null; createdAt: Date }, now = new Date()): Date {
  const cap = new Date(now.valueOf() - EVENT_LOOKBACK_CAP_MS)
  const anchor = trigger.lastFiredAt ?? trigger.createdAt
  return anchor.valueOf() > cap.valueOf() ? anchor : cap
}

async function loadMatchingOutboxEvents(args: {
  since: Date
  lastFiredAt: Date | null
  matchesEventType: (eventType: string) => boolean
  filter: unknown
}) {
  const matched = []
  let scanned = 0
  let cursor: string | undefined

  while (matched.length < EVENT_TRIGGER_BATCH_SIZE && scanned < EVENT_TRIGGER_MAX_SCAN) {
    const batch = await prisma.outboxEvent.findMany({
      where: { createdAt: { gte: args.since }, status: 'PROCESSED' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(EVENT_TRIGGER_BATCH_SIZE, EVENT_TRIGGER_MAX_SCAN - scanned),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (batch.length === 0) break

    scanned += batch.length
    cursor = batch[batch.length - 1].id

    for (const event of batch) {
      if (args.lastFiredAt && event.createdAt < args.lastFiredAt) continue
      if (args.lastFiredAt && event.createdAt.getTime() === args.lastFiredAt.getTime() && processedEventIds.has(event.id)) continue
      if (!args.matchesEventType(event.eventType)) continue
      if (!matchesEventFilter((event.payload ?? {}) as Record<string, unknown>, args.filter)) continue
      matched.push(event)
      if (matched.length >= EVENT_TRIGGER_BATCH_SIZE) break
    }

    if (batch.length < EVENT_TRIGGER_BATCH_SIZE) break
  }

  return matched
}

function matchesCronNow(expr: string, now: Date, timezone?: string): boolean {
  // node-cron doesn't expose a "matches now" helper; we approximate by parsing
  // the expression and comparing fields. node-cron format: sec? min hr dom mon dow.
  const parts = expr.trim().split(/\s+/)
  let sec = '*', min, hr, dom, mon, dow
  if (parts.length === 6) {
    [sec, min, hr, dom, mon, dow] = parts
  } else if (parts.length === 5) {
    [min, hr, dom, mon, dow] = parts
  } else {
    return false
  }
  const cronNow = timezone ? datePartsInTimeZone(now, timezone) : {
    seconds: now.getSeconds(),
    minutes: now.getMinutes(),
    hours: now.getHours(),
    date: now.getDate(),
    month: now.getMonth() + 1,
    day: now.getDay(),
  }
  const fields = [
    { val: cronNow.seconds, expr: sec },
    { val: cronNow.minutes, expr: min! },
    { val: cronNow.hours, expr: hr! },
    { val: cronNow.date, expr: dom! },
    { val: cronNow.month, expr: mon! },
    { val: cronNow.day, expr: dow! },
  ]
  return fields.every(f => fieldMatches(f.expr, f.val))
}

function datePartsInTimeZone(now: Date, timezone: string): {
  seconds: number
  minutes: number
  hours: number
  date: number
  month: number
  day: number
} {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)
    const byType = Object.fromEntries(parts.map(part => [part.type, part.value]))
    const year = Number(byType.year)
    const month = Number(byType.month)
    const date = Number(byType.day)
    return {
      seconds: Number(byType.second),
      minutes: Number(byType.minute),
      hours: Number(byType.hour),
      date,
      month,
      day: new Date(Date.UTC(year, month - 1, date)).getUTCDay(),
    }
  } catch {
    return {
      seconds: now.getSeconds(),
      minutes: now.getMinutes(),
      hours: now.getHours(),
      date: now.getDate(),
      month: now.getMonth() + 1,
      day: now.getDay(),
    }
  }
}

function fieldMatches(expr: string, val: number): boolean {
  if (expr === '*') return true
  if (expr.startsWith('*/')) {
    const step = parseInt(expr.slice(2), 10)
    return Number.isFinite(step) && step > 0 && val % step === 0
  }
  if (/^\d+$/.test(expr)) return parseInt(expr, 10) === val
  if (expr.includes(',')) return expr.split(',').some(p => fieldMatches(p, val))
  if (expr.includes('-')) {
    const [a, b] = expr.split('-').map(s => parseInt(s, 10))
    return val >= a && val <= b
  }
  return false
}

function matchesEventFilter(payload: Record<string, unknown>, filter: unknown): boolean {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return true
  return Object.entries(filter as Record<string, unknown>).every(([path, expected]) => {
    const actual = path.split('.').reduce<unknown>((cur, key) => {
      if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[key]
      return undefined
    }, payload)
    return JSON.stringify(actual) === JSON.stringify(expected)
  })
}

async function spawnInstance(
  triggerId: string,
  templateId: string,
  templateName: string,
  context: Record<string, unknown>,
): Promise<void> {
  // RLS prep — tenantIdForCreate(context) resolves to undefined here today:
  // the SCHEDULE/EVENT trigger contexts built above (_triggeredAt/_trigger/
  // _triggerEvent) never carry a tenantId, because WorkflowTrigger/Workflow
  // have no tenant column to source one from (a separate, deferred product
  // decision — see the RLS cutover plan's Decision C). Wrapping the write
  // anyway keeps the mechanism consistent with every other instance-creating
  // path and makes the gap LOUD (a ValidationError under
  // TENANT_ISOLATION_MODE=strict) instead of a silent bypass; behavior is
  // otherwise unchanged (tenantId: undefined here is exactly what the bare
  // `prisma.workflowInstance.create` call already did).
  const tenantId = tenantIdForCreate(context)
  const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.create({
    data: {
      templateId,
      name: `${templateName} (auto-triggered)`,
      status: 'DRAFT',
      tenantId,
      context: context as object,
    },
  }), tenantId)
  await logEvent('WorkflowTriggered', 'WorkflowInstance', instance.id, undefined, {
    triggerId, templateId,
  })
  await publishOutbox('WorkflowInstance', instance.id, 'WorkflowTriggered', {
    instanceId: instance.id, triggerId,
  })
}
