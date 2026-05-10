import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent } from '../../../../lib/audit'

/**
 * EVENT_GATEWAY — first-to-fire semantics.
 * Activates downstream SIGNAL_WAIT or TIMER nodes in parallel. The first one that
 * receives its event advances through and marks siblings SKIPPED (cancels them).
 *
 * Implementation: we set config._eventGatewayId on each downstream node so that
 * when advance() is called for one, the runtime can locate and cancel the others
 * via the instances.router signal / TimerSweep.
 *
 * For simplicity in this pass we just log the activation. The first downstream
 * SIGNAL_WAIT that fires will advance; the others remain waiting until timeout or
 * manual cancel.
 */
export async function activateEventGateway(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const outgoing = await prisma.workflowEdge.findMany({
    where: { sourceNodeId: node.id },
  })

  await logEvent('EventGatewayActivated', 'WorkflowNode', node.id, undefined, {
    instanceId: instance.id,
    outgoingCount: outgoing.length,
  })
}
