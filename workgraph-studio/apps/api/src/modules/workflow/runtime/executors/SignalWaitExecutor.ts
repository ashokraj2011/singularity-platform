import type { WorkflowNode, WorkflowInstance } from '@prisma/client'

/**
 * SignalWaitExecutor leaves the node ACTIVE indefinitely.
 * It is advanced by external `POST /workflow-instances/:id/signals/:name` calls
 * which match against `config.signalName`.
 */
export async function activateSignalWait(
  _node: WorkflowNode,
  _instance: WorkflowInstance,
): Promise<void> {
  // No-op: the runtime already marked the node ACTIVE before calling.
  // The node will remain ACTIVE until an external signal advances it.
}
