import type { WorkflowNode, WorkflowInstance, Prisma } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'

/**
 * TimerExecutor sets the node into ACTIVE status with a `_fireAt` ISO timestamp
 * stored in its config. The TimerSweep poller checks `_fireAt` periodically and
 * advances the node when the time arrives.
 *
 * Config supports:
 *   { durationMs: number }        — fire N ms after activation
 *   { until: ISO-8601 timestamp } — fire at a specific instant
 */
export async function activateTimer(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const std = cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard)
    ? cfg.standard as Record<string, unknown>
    : {}
  const value = (key: string) => cfg[key] ?? std[key]
  let fireAt: Date | undefined

  const until = value('until')
  const durationMs = value('durationMs')
  const duration = value('duration')
  if (typeof until === 'string') {
    const parsed = new Date(until)
    if (!isNaN(parsed.valueOf())) fireAt = parsed
  } else if ((typeof durationMs === 'number' || typeof durationMs === 'string') && Number(durationMs) >= 0) {
    fireAt = new Date(Date.now() + Number(durationMs))
  } else if (typeof duration === 'string') {
    // Accept e.g. "30s", "5m", "2h"
    const match = /^(\d+)\s*(s|m|h)$/.exec(duration.trim())
    if (match) {
      const n = parseInt(match[1], 10)
      const unit = match[2]
      const ms = unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000
      fireAt = new Date(Date.now() + ms)
    }
  }

  // Default: fire immediately if no config
  if (!fireAt) fireAt = new Date()

  const updated = { ...cfg, _fireAt: fireAt.toISOString() }
  await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.update({
    where: { id: node.id },
    data: { config: updated as Prisma.InputJsonValue },
  }), instance.tenantId ?? undefined)
}
