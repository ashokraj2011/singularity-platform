import type { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma'
import { withTenantDbTransaction } from '../../../lib/tenant-db-context'

// P1-12 durable signals. A signal emitted before its SIGNAL_WAIT node parks was
// silently lost (delivery matched only nodes already ACTIVE at emit time). We now
// persist every emitted signal so a waiter that arrives LATER can still consume
// it. Instance-scoped (the emit-before-wait race is between parallel branches of
// one run); windowed via expiresAt so stale signals don't wake very-late waiters.

// How long a persisted, unconsumed signal stays claimable. Floor 60s.
const SIGNAL_TTL_MS = Math.max(60_000, Number(process.env.WORKFLOW_SIGNAL_TTL_MS ?? 24 * 60 * 60_000))

function cleanKey(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

// Persist an emitted signal. Returns the new row id so a live emit that also
// delivered the signal to an ACTIVE waiter can mark it consumed.
export async function persistSignal(args: {
  instanceId: string
  signalName: string
  correlationKey?: unknown
  payload?: Prisma.InputJsonValue
  tenantId?: string
}): Promise<string | null> {
  if (!args.instanceId || !cleanKey(args.signalName)) return null
  try {
    const row = await withTenantDbTransaction(prisma, (tx) => tx.workflowSignal.create({
      data: {
        instanceId: args.instanceId,
        signalName: args.signalName,
        correlationKey: cleanKey(args.correlationKey) ?? null,
        payload: args.payload ?? undefined,
        expiresAt: new Date(Date.now() + SIGNAL_TTL_MS),
      },
    }), args.tenantId)
    return row.id
  } catch {
    // Durability is best-effort — a failure here must not break live delivery.
    return null
  }
}

// Mark a persisted signal consumed — called when a live emit already delivered it
// to an ACTIVE waiter in the emitting instance, so a later waiter doesn't re-fire
// on the same emit. Best-effort.
export async function markSignalConsumed(signalId: string | null, tenantId?: string): Promise<void> {
  if (!signalId) return
  await withTenantDbTransaction(prisma, (tx) => tx.workflowSignal.updateMany({
    where: { id: signalId, consumedAt: null },
    data: { consumedAt: new Date() },
  }), tenantId).catch(() => {})
}

// Atomically claim a pending (unconsumed, unexpired) signal matching this waiter,
// scoped to the instance. Returns its payload if claimed, else null. The
// updateMany `consumedAt: null` guard is the single-winner claim, so two waiters
// racing for the same signal can't both consume it.
export async function consumePendingSignal(args: {
  instanceId: string
  signalName: string
  correlationKey?: unknown
  tenantId?: string
}): Promise<{ payload: unknown } | null> {
  if (!args.instanceId || !cleanKey(args.signalName)) return null
  const correlationKey = cleanKey(args.correlationKey)
  const now = new Date()
  return withTenantDbTransaction(prisma, async (tx) => {
    const candidates = await tx.workflowSignal.findMany({
      where: {
        instanceId: args.instanceId,
        signalName: args.signalName,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { emittedAt: 'asc' },
      take: 25,
    })
    for (const sig of candidates) {
      // Correlation is enforced only when BOTH sides set it — mirrors live delivery.
      if (correlationKey && sig.correlationKey && sig.correlationKey !== correlationKey) continue
      const claim = await tx.workflowSignal.updateMany({
        where: { id: sig.id, consumedAt: null },
        data: { consumedAt: now },
      })
      if (claim.count === 1) return { payload: sig.payload }
    }
    return null
  }, args.tenantId)
}
