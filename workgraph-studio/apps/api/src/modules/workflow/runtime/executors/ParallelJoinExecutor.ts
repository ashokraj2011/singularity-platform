import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'

// PARALLEL_JOIN (AND-join) sets expected_joins from config so GraphTraverser's
// atomic counter knows when all branches have arrived.
export async function activateParallelJoin(
  node: WorkflowNode,
  _instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const expectedBranches = Number(cfg.expectedBranches ?? 2)

  await prisma.workflowNode.update({
    where: { id: node.id },
    data: {
      status: 'ACTIVE',
      startedAt: new Date(),
      config: { ...cfg, expected_joins: expectedBranches, completed_joins: 0 } as Prisma.InputJsonValue,
    },
  })
}
