import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'

// DECISION_GATE evaluates immediately — advances via outgoing CONDITIONAL edges.
// The WorkflowRuntime.advance() call after activation handles the next step.
export async function activateDecisionGate(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  // Mark active so advance() can pick up outgoing conditional edges
  await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.update({
    where: { id: node.id },
    data: { status: 'ACTIVE', startedAt: new Date() },
  }), instance.tenantId ?? undefined)
}
