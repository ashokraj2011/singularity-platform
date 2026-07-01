import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'

// PARALLEL_FORK (AND-split) is a visual anchor only.
// The runtime fires ALL outgoing PARALLEL_SPLIT edges automatically.
// This executor just confirms activation so advance() can proceed.
export async function activateParallelFork(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.update({
    where: { id: node.id },
    data: { status: 'ACTIVE', startedAt: new Date() },
  }), instance.tenantId ?? undefined)
}
