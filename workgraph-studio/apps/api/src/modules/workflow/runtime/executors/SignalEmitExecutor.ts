import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
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
  const tenantId = instance.tenantId ?? undefined

  const ctx = (instance.context ?? {}) as Record<string, unknown>
  const payload: Record<string, unknown> = payloadPath
    ? { data: getNestedValue(ctx, payloadPath) }
    : {}

  // Find all ACTIVE SIGNAL_WAIT nodes matching this signal name.
  // RLS prep — scoped to the emitting instance's own tenant. Once FORCE ROW
  // LEVEL SECURITY is live this narrows delivery to same-tenant instances
  // only (previously reached "across all workflow instances" per the
  // broadcast design in the header comment). Treated as a deliberate,
  // desired narrowing rather than a gap to backfill: delivering a signal's
  // payload across a tenant boundary would otherwise be a cross-tenant data
  // leak. A genuinely cross-tenant signal broadcast, if ever needed, is a
  // new product decision — not addressed here.
  const waitingNodes = await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.findMany({
    where: { nodeType: 'SIGNAL_WAIT', status: 'ACTIVE' },
    include: { instance: { select: { tenantId: true } } },
  }), tenantId)

  for (const waitNode of waitingNodes) {
    const waitCfg = (waitNode.config ?? {}) as Record<string, unknown>
    const waitStd = (waitCfg.standard ?? {}) as Record<string, string>
    if (waitStd.signalName !== signalName) continue
    if (correlationKey && waitStd.correlationKey && waitStd.correlationKey !== correlationKey) continue

    await advance(waitNode.instanceId, waitNode.id, { ...payload, _signal: signalName }, undefined, undefined, waitNode.instance.tenantId ?? undefined)
  }
}
