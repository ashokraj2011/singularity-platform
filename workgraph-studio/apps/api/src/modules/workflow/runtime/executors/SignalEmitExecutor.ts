import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { advance } from '../WorkflowRuntime'

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[key]
    return undefined
  }, obj)
}

// SIGNAL_EMIT broadcasts a named signal, waking all matching SIGNAL_WAIT nodes
// across all workflow instances, then auto-advances itself.
export async function activateSignalEmit(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const std = (cfg.standard ?? {}) as Record<string, string>
  const signalName = std.signalName ?? ''
  const correlationKey = std.correlationKey ?? ''
  const payloadPath = std.payloadPath ?? ''

  if (!signalName) return

  const ctx = (instance.context ?? {}) as Record<string, unknown>
  const payload: Record<string, unknown> = payloadPath
    ? { data: getNestedValue(ctx, payloadPath) }
    : {}

  // Find all ACTIVE SIGNAL_WAIT nodes matching this signal name
  const waitingNodes = await prisma.workflowNode.findMany({
    where: { nodeType: 'SIGNAL_WAIT', status: 'ACTIVE' },
  })

  for (const waitNode of waitingNodes) {
    const waitCfg = (waitNode.config ?? {}) as Record<string, unknown>
    const waitStd = (waitCfg.standard ?? {}) as Record<string, string>
    if (waitStd.signalName !== signalName) continue
    if (correlationKey && waitStd.correlationKey && waitStd.correlationKey !== correlationKey) continue

    await advance(waitNode.instanceId, waitNode.id, { ...payload, _signal: signalName })
  }
}
