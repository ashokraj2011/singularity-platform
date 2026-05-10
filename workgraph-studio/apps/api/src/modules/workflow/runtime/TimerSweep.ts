import cron from 'node-cron'
import { prisma } from '../../../lib/prisma'
import { advance } from './WorkflowRuntime'
import { logEvent, publishOutbox } from '../../../lib/audit'

/**
 * Polls every 5 seconds for ACTIVE TIMER nodes whose `_fireAt` has passed,
 * and advances them. Also scans Tasks with `dueAt <= now` and emits TaskOverdue.
 */
export function startTimerSweep(): void {
  cron.schedule('*/5 * * * * *', async () => {
    const now = new Date()

    // ─── Timer node fire ───────────────────────────────────────────────
    try {
      const activeTimers = await prisma.workflowNode.findMany({
        where: { nodeType: 'TIMER', status: 'ACTIVE' },
        include: { instance: true },
      })

      for (const node of activeTimers) {
        const cfg = (node.config ?? {}) as Record<string, unknown>
        const fireAt = typeof cfg._fireAt === 'string' ? new Date(cfg._fireAt) : null
        if (!fireAt || isNaN(fireAt.valueOf())) continue
        if (fireAt > now) continue
        if (!node.instance || node.instance.status !== 'ACTIVE') continue

        try {
          await advance(node.instanceId, node.id, { _firedAt: now.toISOString() })
        } catch (err) {
          console.error('Timer advance failed:', err)
        }
      }
    } catch (err) {
      console.error('Timer sweep error:', err)
    }

    // ─── Task SLA breach ───────────────────────────────────────────────
    try {
      const overdue = await prisma.task.findMany({
        where: {
          dueAt: { not: null, lte: now },
          status: { in: ['OPEN', 'IN_PROGRESS'] },
        },
        select: { id: true, status: true, dueAt: true, instanceId: true },
        take: 100,
      })

      for (const t of overdue) {
        // Avoid spamming: only emit if no recent TaskOverdue event in last hour
        const recent = await prisma.eventLog.findFirst({
          where: {
            eventType: 'TaskOverdue',
            entityId: t.id,
            occurredAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
          },
        })
        if (recent) continue

        await logEvent('TaskOverdue', 'Task', t.id, undefined, {
          dueAt: t.dueAt?.toISOString(),
          instanceId: t.instanceId,
          status: t.status,
        })
        await publishOutbox('Task', t.id, 'TaskOverdue', {
          taskId: t.id,
          instanceId: t.instanceId,
          dueAt: t.dueAt?.toISOString(),
        })
      }
    } catch (err) {
      console.error('Task SLA sweep error:', err)
    }

    // ─── Deadline attachment fire ──────────────────────────────────────
    try {
      // Find ACTIVE nodes that have _deadlineFireAt stored in config and the time has passed.
      // Using raw SQL because Prisma can't efficiently filter by JSON sub-fields.
      const overdue = await prisma.$queryRaw<Array<{ id: string; instanceId: string; config: unknown }>>`
        SELECT id, "instanceId", config
        FROM "workflow_nodes"
        WHERE status = 'ACTIVE'
          AND config->>'_deadlineFireAt' IS NOT NULL
          AND (config->>'_deadlineFireAt')::timestamptz <= ${now}::timestamptz
      `

      for (const row of overdue) {
        const cfg = (row.config ?? {}) as Record<string, unknown>
        const edgeLabel = typeof cfg._deadlineEdge === 'string' ? cfg._deadlineEdge : ''
        try {
          await advance(row.instanceId, row.id, {
            _deadlineTriggered: true,
            _deadlineAt: now.toISOString(),
            _deadlineEdge: edgeLabel,
          })
          await logEvent('NodeDeadlineFired', 'WorkflowNode', row.id, undefined, {
            instanceId: row.instanceId,
            edgeLabel,
          })
        } catch (err) {
          console.error('Deadline advance failed:', err)
        }
      }
    } catch (err) {
      console.error('Deadline sweep error:', err)
    }
  })
  console.log('Timer + SLA sweep started')
}
