// ─────────────────────────────────────────────────────────────────────────────
// Service-bound executors — route to adapters. When the required adapter is
// offline they translate OfflineError into a BLOCKED outcome, so the run parks
// (durably, in the StateStore) and can resume/sync once reconnected. This is the
// "degrade / queue" behavior for human & IAM steps chosen in the plan.
// ─────────────────────────────────────────────────────────────────────────────

import type { ExecContext, ExecOutcome, NodeExecutor } from '../types.js'
import { OfflineError } from '../types.js'

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export const humanTaskExecutor: NodeExecutor = {
  handles: ['HUMAN_TASK', 'APPROVAL'],
  async execute(ctx: ExecContext): Promise<ExecOutcome> {
    const cfg = (ctx.node.config ?? {}) as Record<string, unknown>
    try {
      const res = await ctx.adapters.human.requestDecision({
        runId: ctx.runId,
        nodeId: ctx.node.id,
        title: asString(cfg.title, ctx.node.label ?? ctx.node.id),
        assignee: asString(cfg.assignee) || undefined,
      })
      await ctx.adapters.audit.emit({
        runId: ctx.runId,
        nodeId: ctx.node.id,
        kind: 'HumanDecision',
        payload: { decision: res.decision, by: res.by },
      })
      if (res.decision === 'REJECTED') return { kind: 'FAILED', reason: 'human rejected' }
      return { kind: 'COMPLETED', output: { decision: res.decision, decidedBy: res.by } }
    } catch (err) {
      if (err instanceof OfflineError) {
        ctx.log('HumanTaskDeferred', 'offline — parking node for later decision')
        return { kind: 'BLOCKED', reason: 'awaiting human decision (offline)' }
      }
      throw err
    }
  },
}

/**
 * GOVERNANCE_GATE — enforce the bundled policy snapshot. Offline and unable to
 * reach IAM, a fail-closed policy blocks (does not silently allow). When the
 * node type is not gated by policy, it passes through.
 */
export const governanceGateExecutor: NodeExecutor = {
  handles: ['GOVERNANCE_GATE', 'POLICY_CHECK'],
  async execute(ctx: ExecContext): Promise<ExecOutcome> {
    const cfg = (ctx.node.config ?? {}) as Record<string, unknown>
    const capabilityId = asString(cfg.capabilityId)

    // If the capability is explicitly allow-listed in the bundled policy, we can
    // clear the gate without any online call.
    if (capabilityId && ctx.policy.allowedCapabilities.includes(capabilityId)) {
      return { kind: 'COMPLETED', output: { decision: 'ALLOWED', source: 'bundled-policy' } }
    }

    try {
      const res = await ctx.adapters.iam.authzCheck({
        capabilityId: capabilityId || ctx.node.id,
        actorId: asString(ctx.context._actorId),
        tenantId: asString(ctx.context._tenantId) || undefined,
      })
      if (!res.allowed) return { kind: 'FAILED', reason: res.reason ?? 'authorization denied' }
      return { kind: 'COMPLETED', output: { decision: 'ALLOWED', source: 'iam' } }
    } catch (err) {
      if (err instanceof OfflineError) {
        if (ctx.policy.failClosed) {
          ctx.log('GovernanceGateBlocked', 'offline + fail-closed — blocking')
          return { kind: 'BLOCKED', reason: 'governance gate offline (fail-closed)' }
        }
        // fail-open only when the policy explicitly permits it
        return { kind: 'COMPLETED', output: { decision: 'ALLOWED', source: 'fail-open' } }
      }
      throw err
    }
  },
}
