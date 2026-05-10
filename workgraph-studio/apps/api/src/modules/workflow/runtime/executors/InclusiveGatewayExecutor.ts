import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { logEvent } from '../../../../lib/audit'

/**
 * INCLUSIVE_GATEWAY — OR semantics.
 * All outgoing CONDITIONAL edges whose conditions evaluate to true are followed
 * simultaneously. The GraphTraverser's evaluateEdge already returns true for each
 * matching CONDITIONAL edge, so we just need to log activation. The actual branch
 * selection is handled by activateDownstream → resolveNextNodes (all matching edges
 * are resolved, no single-branch short-circuit).
 */
export async function activateInclusiveGateway(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  await logEvent('InclusiveGatewayActivated', 'WorkflowNode', node.id, undefined, {
    instanceId: instance.id,
  })
}
