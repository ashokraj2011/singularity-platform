import cron from 'node-cron'
import { prisma } from '../../../lib/prisma'
import { adminPrisma } from '../../../lib/admin-prisma'
import { advance, failNode } from './WorkflowRuntime'
import { withTenantDbTransaction } from '../../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../../lib/audit'

// RLS prep — TimerSweep's discovery queries below scan ACROSS EVERY TENANT in
// one shot (that's what a sweep is); no single tenant's transaction can
// produce a cross-tenant result set. adminPrisma (the workgraph owner/admin
// connection, NOSUPERUSER-exempt from RLS) is used ONLY for these read-only
// discovery reads, falling back to the regular tenant-scoped `prisma` client
// when WORKGRAPH_DATABASE_URL_ADMIN isn't configured — today's exact
// behavior. Every per-item WRITE downstream (advance()) still goes through
// the normal tenant-scoped path, using the tenantId the discovery query
// already has in hand (via the eager-loaded instance relation / a join).
const sweepReader = adminPrisma ?? prisma

/**
 * Polls every 5 seconds for ACTIVE TIMER nodes whose `_fireAt` has passed,
 * and advances them. Also scans Tasks with `dueAt <= now` and emits TaskOverdue.
 */
export function startTimerSweep(): void {
  cron.schedule('*/5 * * * * *', async () => {
    const now = new Date()

    // ─── Timer node fire ───────────────────────────────────────────────
    try {
      const activeTimers = await sweepReader.workflowNode.findMany({
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
          await advance(node.instanceId, node.id, { _firedAt: now.toISOString() }, undefined, undefined, node.instance.tenantId ?? undefined)
        } catch (err) {
          console.error('Timer advance failed:', err)
        }
      }
    } catch (err) {
      console.error('Timer sweep error:', err)
    }

    // ─── Task SLA breach ───────────────────────────────────────────────
    try {
      const overdue = await sweepReader.task.findMany({
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
      // Using raw SQL because Prisma can't efficiently filter by JSON sub-fields. Joins
      // workflow_instances to pull the owning instance's tenantId in the SAME cross-tenant
      // discovery query (RLS prep — see sweepReader comment above), so the per-row advance()
      // below can be tenant-scoped without a second round trip.
      const overdue = await sweepReader.$queryRaw<Array<{ id: string; instanceId: string; config: unknown; instanceTenantId: string | null }>>`
        SELECT wn.id, wn."instanceId", wn.config, wi."tenantId" AS "instanceTenantId"
        FROM "workflow_nodes" wn
        JOIN "workflow_instances" wi ON wi.id = wn."instanceId"
        WHERE wn.status = 'ACTIVE'
          AND wn.config->>'_deadlineFireAt' IS NOT NULL
          AND (wn.config->>'_deadlineFireAt')::timestamptz <= ${now}::timestamptz
      `

      for (const row of overdue) {
        const cfg = (row.config ?? {}) as Record<string, unknown>
        const edgeLabel = typeof cfg._deadlineEdge === 'string' ? cfg._deadlineEdge : ''
        try {
          await advance(row.instanceId, row.id, {
            _deadlineTriggered: true,
            _deadlineAt: now.toISOString(),
            _deadlineEdge: edgeLabel,
          }, undefined, undefined, row.instanceTenantId ?? undefined)
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

    // ─── Pending-execution expiry ──────────────────────────────────────
    // A non-SERVER node queues a pending_executions row for a runner (poll-runner)
    // to claim + complete. If no runner ever does — none deployed, or it died — the
    // row expires (expiresAt, 24h default). Fail those nodes so a missing runner
    // surfaces as a real node failure instead of an eternal ACTIVE. A runner
    // completion clears the row (completedAt) before this fires, so only genuinely
    // stuck rows match.
    try {
      const expired = await sweepReader.pendingExecution.findMany({
        where: { completedAt: null, expiresAt: { lt: now } },
        include: {
          node: { select: { status: true } },
          instance: { select: { status: true, tenantId: true } },
        },
        take: 100,
      })

      for (const row of expired) {
        const tenantId = row.instance?.tenantId ?? undefined
        const reason = `No runner completed this ${row.location} node before it expired at ${row.expiresAt.toISOString()}.`
        try {
          // Mark the row done first so it isn't re-swept, then fail the node if it's
          // still the ACTIVE one waiting on this row (skip stale rows whose node or
          // run already moved on).
          await withTenantDbTransaction(prisma, (tx) => tx.pendingExecution.update({
            where: { id: row.id },
            data: { completedAt: now, error: reason },
          }), tenantId)
          if (row.instance?.status === 'ACTIVE' && row.node?.status === 'ACTIVE') {
            await failNode(row.instanceId, row.nodeId, { message: reason, code: 'PENDING_EXECUTION_EXPIRED' }, undefined, tenantId)
          }
          await logEvent('PendingExecutionExpired', 'WorkflowNode', row.nodeId, undefined, {
            instanceId: row.instanceId,
            pendingExecutionId: row.id,
            location: row.location,
          })
        } catch (err) {
          console.error('Pending-execution expiry failed:', err)
        }
      }
    } catch (err) {
      console.error('Pending-execution expiry sweep error:', err)
    }
  })
  console.log('Timer + SLA sweep started')
}
