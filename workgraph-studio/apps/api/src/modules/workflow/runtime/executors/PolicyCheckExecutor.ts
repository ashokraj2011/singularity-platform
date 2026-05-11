import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'

export async function activatePolicyCheck(
  node: WorkflowNode,
  _instance: WorkflowInstance,
): Promise<void> {
  // Policy check nodes auto-evaluate and mark themselves COMPLETED or BLOCKED.
  // Full policy evaluation is wired through PolicyEngine in the Tool Gateway.
  // For workflow-level policy gates, mark COMPLETED (allow) by default in MVP.
  // Auto-completed gate — stamp completedAt for insights.
  const now = new Date()
  await prisma.workflowNode.update({
    where: { id: node.id },
    data: { status: 'COMPLETED', startedAt: now, completedAt: now },
  })
}
