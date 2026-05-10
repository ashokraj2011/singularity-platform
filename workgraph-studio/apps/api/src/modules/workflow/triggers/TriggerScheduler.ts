import cron from 'node-cron'
import { prisma } from '../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../lib/audit'

/**
 * SCHEDULE-type triggers fire instances on a cron expression. EVENT-type
 * triggers subscribe to OutboxEvent rows whose `eventType` matches their
 * config.eventType. Both are evaluated on a 30s tick.
 */
export function startTriggerScheduler(): void {
  cron.schedule('*/30 * * * * *', async () => {
    await runScheduleTriggers()
    await runEventTriggers()
  })
  console.log('Trigger scheduler started')
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
      if (!cronExpr || !cron.validate(cronExpr)) continue

      // Simple "did we miss this minute?" — fire if last fire was >60s ago and
      // current minute matches the cron's next-tick window.
      const lastFiredMs = t.lastFiredAt ? t.lastFiredAt.valueOf() : 0
      if (now.valueOf() - lastFiredMs < 60_000) continue
      if (!matchesCronNow(cronExpr, now)) continue

      await spawnInstance(t.id, t.templateId, t.template.name, { _triggeredAt: now.toISOString() })
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

    const since = new Date(Date.now() - 60_000)
    const recentEvents = await prisma.outboxEvent.findMany({
      where: { createdAt: { gte: since }, status: 'PROCESSED' },
      take: 200,
    })

    for (const t of triggers) {
      const cfg = (t.config ?? {}) as Record<string, unknown>
      const wantedType = typeof cfg.eventType === 'string' ? cfg.eventType : null
      if (!wantedType) continue

      const matched = recentEvents.find(e =>
        e.eventType === wantedType
        && (!t.lastFiredAt || e.createdAt > t.lastFiredAt)
      )
      if (!matched) continue

      await spawnInstance(t.id, t.templateId, t.template.name, {
        _triggeredAt: new Date().toISOString(),
        _triggerEvent: { type: matched.eventType, payload: matched.payload },
      })
      await prisma.workflowTrigger.update({
        where: { id: t.id },
        data: { lastFiredAt: new Date() },
      })
    }
  } catch (err) {
    console.error('Event trigger error:', err)
  }
}

function matchesCronNow(expr: string, now: Date): boolean {
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
  const fields = [
    { val: now.getSeconds(), expr: sec },
    { val: now.getMinutes(), expr: min! },
    { val: now.getHours(), expr: hr! },
    { val: now.getDate(), expr: dom! },
    { val: now.getMonth() + 1, expr: mon! },
    { val: now.getDay(), expr: dow! },
  ]
  return fields.every(f => fieldMatches(f.expr, f.val))
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

async function spawnInstance(
  triggerId: string,
  templateId: string,
  templateName: string,
  context: Record<string, unknown>,
): Promise<void> {
  const instance = await prisma.workflowInstance.create({
    data: {
      templateId,
      name: `${templateName} (auto-triggered)`,
      status: 'DRAFT',
      context: context as object,
    },
  })
  await logEvent('WorkflowTriggered', 'WorkflowInstance', instance.id, undefined, {
    triggerId, templateId,
  })
  await publishOutbox('WorkflowInstance', instance.id, 'WorkflowTriggered', {
    instanceId: instance.id, triggerId,
  })
}
