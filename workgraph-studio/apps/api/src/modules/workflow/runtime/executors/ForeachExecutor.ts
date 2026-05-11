import type { WorkflowNode, WorkflowInstance, Prisma } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'

/**
 * ForeachExecutor records the iteration plan on the node config.
 * Real fan-out execution requires sub-workflow or inner-graph support;
 * MVP records the collection size and marks the node COMPLETED, treating each
 * item as a single context iteration produced by upstream tools.
 *
 * Config: { collectionPath: string, itemVar: string, parallel?: boolean, maxConcurrency?: number }
 */
export async function activateForeach(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const collectionPath = typeof cfg.collectionPath === 'string' ? cfg.collectionPath : undefined
  const ctx = (instance.context ?? {}) as Record<string, unknown>

  let collection: unknown[] = []
  if (collectionPath) {
    const resolved = collectionPath.split('.').reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object') ? (acc as Record<string, unknown>)[k] : undefined,
      ctx,
    )
    if (Array.isArray(resolved)) collection = resolved
  }

  await prisma.workflowNode.update({
    where: { id: node.id },
    data: {
      config: { ...cfg, _items: collection.length, _completed: 0 } as Prisma.InputJsonValue,
    },
  })

  // For MVP, mark COMPLETED if collection is empty; otherwise leave ACTIVE for
  // an external orchestrator to fan out and signal back.
  if (collection.length === 0) {
    await prisma.workflowNode.update({
      where: { id: node.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
  }
}
