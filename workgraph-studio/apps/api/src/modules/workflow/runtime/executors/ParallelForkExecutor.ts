import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'

// PARALLEL_FORK (AND-split) is a visual anchor only.
// The runtime fires ALL outgoing PARALLEL_SPLIT edges automatically.
// This executor just confirms activation so advance() can proceed.
export async function activateParallelFork(
  node: WorkflowNode,
  _instance: WorkflowInstance,
): Promise<void> {
  await prisma.workflowNode.update({
    where: { id: node.id },
    data: { status: 'ACTIVE', startedAt: new Date() },
  })
}
