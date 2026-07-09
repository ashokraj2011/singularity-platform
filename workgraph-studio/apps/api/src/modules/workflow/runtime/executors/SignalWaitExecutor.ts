import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { consumePendingSignal } from '../signals'

export type SignalWaitResult =
  | { consumed: false }
  | { consumed: true; signalName: string; payload: unknown }

/**
 * SIGNAL_WAIT activation.
 *
 * The runtime already marked the node ACTIVE before calling. Normally the node
 * stays ACTIVE until a signal arrives (live delivery via SIGNAL_EMIT or
 * POST /workflow-instances/:id/signals/:name).
 *
 * P1-12 — but a signal EMITTED BEFORE this node parked used to be lost. So on
 * activation we first check for a matching pending (persisted, unconsumed,
 * unexpired) signal for this instance and, if one is claimed, report it so the
 * dispatcher advances immediately instead of waiting forever.
 */
export async function activateSignalWait(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<SignalWaitResult> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const std = cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard)
    ? cfg.standard as Record<string, unknown>
    : {}
  const signalName = (typeof cfg.signalName === 'string' && cfg.signalName.trim() ? cfg.signalName.trim() : undefined)
    ?? (typeof std.signalName === 'string' && std.signalName.trim() ? std.signalName.trim() : undefined)
  if (!signalName) return { consumed: false }
  const correlationKey = (typeof cfg.correlationKey === 'string' ? cfg.correlationKey : undefined)
    ?? (typeof std.correlationKey === 'string' ? std.correlationKey : undefined)

  const pending = await consumePendingSignal({
    instanceId: instance.id,
    signalName,
    correlationKey,
    tenantId: instance.tenantId ?? undefined,
  })
  if (!pending) return { consumed: false }
  return { consumed: true, signalName, payload: pending.payload }
}
