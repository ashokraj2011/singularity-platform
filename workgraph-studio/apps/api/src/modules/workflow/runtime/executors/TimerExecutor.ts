import type { WorkflowNode, WorkflowInstance, Prisma } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'

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
  _instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  let fireAt: Date | undefined

  if (typeof cfg.until === 'string') {
    const parsed = new Date(cfg.until)
    if (!isNaN(parsed.valueOf())) fireAt = parsed
  } else if (typeof cfg.durationMs === 'number' && cfg.durationMs >= 0) {
    fireAt = new Date(Date.now() + cfg.durationMs)
  } else if (typeof cfg.duration === 'string') {
    // Accept e.g. "30s", "5m", "2h"
    const match = /^(\d+)\s*(s|m|h)$/.exec(cfg.duration.trim())
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
  await prisma.workflowNode.update({
    where: { id: node.id },
    data: { config: updated as Prisma.InputJsonValue },
  })
}
