import cron from 'node-cron'
import { prisma } from '../../../lib/prisma'
import { adminPrisma } from '../../../lib/admin-prisma'
import { failNode } from './WorkflowRuntime'
import { withTenantDbTransaction } from '../../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../../lib/audit'
import { config } from '../../../config'

// RLS prep — same pattern as TimerSweep: discovery scans across every tenant via
// adminPrisma (RLS-exempt owner, falls back to tenant-scoped prisma when the admin
// URL isn't set); every per-row WRITE goes through the tenant-scoped path using the
// tenantId the discovery join already has in hand.
const sweepReader = adminPrisma ?? prisma

/**
 * Stuck-run watchdog (durable-execution hardening).
 *
 * A SERVER node whose in-process execution died mid-run (process crash, unhandled
 * rejection, OOM) is left ACTIVE with nothing to recover it — no timer (`_fireAt`),
 * no `pending_executions` row, no signal wait. TimerSweep already covers timers,
 * deadlines, task SLAs, and pending-execution expiry; this fills that last gap.
 *
 * Every minute it finds ACTIVE non-wait nodes untouched past
 * WORKFLOW_STUCK_NODE_THRESHOLD_MS and, via an atomic per-attempt claim, calls
 * failNode() — which RETRIES (re-dispatches) if the node's retryPolicy has attempts
 * left, else FAILs the node so the stuck run surfaces loudly instead of hanging
 * forever. Fail-soft: any per-row error is logged and never aborts the sweep.
 *
 * Wait-type nodes (HUMAN_TASK / WORKBENCH_TASK / APPROVAL / SIGNAL_WAIT / TIMER /
 * CREATE_BRANCH / GOVERNANCE_GATE / PARALLEL_JOIN / EVENT_GATEWAY / FOREACH) and
 * nodes carrying an `_awaiting*` / `_fireAt` / `_deadlineFireAt` marker or an
 * un-completed pending_executions row are deliberately EXCLUDED — they are
 * legitimately ACTIVE while awaiting an external action / sibling / runner.
 */
export function startStuckRunSweep(): void {
  if (config.WORKFLOW_STUCK_WATCHDOG_ENABLED !== 'true') {
    console.log('Stuck-run watchdog disabled (WORKFLOW_STUCK_WATCHDOG_ENABLED=false)')
    return
  }
  const thresholdMs = config.WORKFLOW_STUCK_NODE_THRESHOLD_MS

  cron.schedule('0 * * * * *', async () => {
    const now = new Date()
    const threshold = new Date(now.getTime() - thresholdMs)
    try {
      // Raw SQL: filter on JSON sub-fields + a NOT EXISTS the ORM can't express
      // efficiently, and join the instance to pull tenantId in the same cross-tenant
      // discovery query (RLS prep). The nodeType list is a fixed set of constants.
      const stuck = await sweepReader.$queryRaw<Array<{
        id: string; instanceId: string; nodeType: string; instanceTenantId: string | null
      }>>`
        SELECT wn.id, wn."instanceId", wn."nodeType", wi."tenantId" AS "instanceTenantId"
        FROM "workflow_nodes" wn
        JOIN "workflow_instances" wi ON wi.id = wn."instanceId"
        WHERE wn.status = 'ACTIVE'
          AND wi.status = 'ACTIVE'
          AND wn."updatedAt" < ${threshold}
          AND wn."nodeType" NOT IN (
            'START', 'END', 'HUMAN_TASK', 'WORKBENCH_TASK', 'APPROVAL', 'SIGNAL_WAIT',
            'TIMER', 'CREATE_BRANCH', 'GOVERNANCE_GATE', 'PARALLEL_JOIN', 'EVENT_GATEWAY', 'FOREACH'
          )
          AND NOT (
            wn.config ? '_awaitingStart' OR wn.config ? '_awaitingBranchInput'
            OR wn.config ? '_blockedByGovernanceGate' OR wn.config ? '_fireAt'
            OR wn.config ? '_deadlineFireAt'
          )
          AND NOT EXISTS (
            SELECT 1 FROM "pending_executions" pe
            WHERE pe."nodeId" = wn.id AND pe."completedAt" IS NULL
          )
        LIMIT 100
      `

      for (const row of stuck) {
        const tenantId = row.instanceTenantId ?? undefined
        const reason = `Node ${row.nodeType} was ACTIVE with no progress for > ${Math.round(thresholdMs / 1000)}s ` +
          `(in-process execution likely died); recovered by the stuck-run watchdog.`
        try {
          // Atomic per-attempt claim. failNode() is not status-guarded (it reads the
          // node fresh, then retries/fails), so without a claim every replica would
          // double-recover. We fence on `_attempts` (the retry counter failNode uses):
          // only one replica claims a given attempt, and because failNode's retry
          // bumps `_attempts` + re-activates the node, a FUTURE stuck of the retried
          // attempt is still detectable (the marker records the attempt we swept).
          const claimed = await withTenantDbTransaction(prisma, (tx) => tx.$executeRaw`
            UPDATE "workflow_nodes"
            SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{_stuckSweptAttempt}',
                                   COALESCE(config->'_attempts', '0'::jsonb))
            WHERE id = ${row.id}
              AND status = 'ACTIVE'
              AND "updatedAt" < ${threshold}
              AND COALESCE(config->>'_stuckSweptAttempt', '') IS DISTINCT FROM COALESCE(config->>'_attempts', '0')
          `, tenantId).catch(() => 0)
          if (claimed !== 1) continue

          const result = await failNode(
            row.instanceId, row.id,
            { message: reason, code: 'NODE_EXECUTION_STUCK' },
            undefined, tenantId,
          )
          await logEvent('NodeStuckRecovered', 'WorkflowNode', row.id, undefined, {
            instanceId: row.instanceId,
            nodeType: row.nodeType,
            retried: result.retried,
            instanceFailed: result.instanceFailed,
            thresholdMs,
          })
          await publishOutbox('WorkflowNode', row.id, 'NodeStuckRecovered', {
            instanceId: row.instanceId,
            nodeId: row.id,
            retried: result.retried,
          })
        } catch (err) {
          console.error('Stuck-run recovery failed:', err)
        }
      }
    } catch (err) {
      console.error('Stuck-run sweep error:', err)
    }
  })
  console.log(`Stuck-run watchdog started (threshold ${Math.round(thresholdMs / 1000)}s)`)
}
