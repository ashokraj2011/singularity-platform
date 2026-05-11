import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'

// ERROR_CATCH is activated by failNode() via an ERROR_BOUNDARY edge.
// It writes the captured error into the workflow context and auto-advances
// so the downstream fallback path (e.g. HUMAN_TASK) can proceed.
export async function activateErrorCatch(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const std = (cfg.standard ?? {}) as Record<string, string>
  const contextPath = std.contextPath || '_error'

  // _lastError was already written into context by failNode(); re-surface under the configured path.
  const ctx = (instance.context ?? {}) as Record<string, unknown>
  const lastError = ctx._lastError

  if (lastError && contextPath !== '_lastError') {
    const updated = { ...ctx, [contextPath]: lastError }
    await prisma.workflowInstance.update({
      where: { id: instance.id },
      data: { context: updated as unknown as Prisma.InputJsonValue },
    })
  }

  await prisma.workflowNode.update({
    where: { id: node.id },
    data: { status: 'ACTIVE', startedAt: new Date() },
  })
}
