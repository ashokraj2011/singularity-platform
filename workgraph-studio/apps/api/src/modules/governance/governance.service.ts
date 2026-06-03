/**
 * Capability Governance Model (G5) — the executor → governance wire.
 *
 * Resolve the governance overlay (IAM) + active waivers for a stage about to be
 * dispatched, set them on the GovernedStageRequest so CF's enforcement gate can
 * act, and snapshot the overlay for audit. This is the chokepoint both governed-
 * stage dispatch sites (AgentTaskExecutor + coding-agent orchestrator) call.
 *
 * Best-effort + FAIL-OPEN: any governance/resolve/IAM error leaves the request
 * unchanged so a governance hiccup never blocks stage dispatch. (The CF gate is
 * fail-CLOSED only when an overlay is actually present + BLOCKING/REQUIRED.)
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { resolveGovernance, type GovernanceResolveContext } from '../../lib/iam/client'
import { activeWaiverControlKeys } from './governance.router'
import type { GovernedStageRequest } from '../../lib/context-fabric/client'

function _str(rc: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rc[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return undefined
}

export async function enrichStageRequestWithGovernance(req: GovernedStageRequest): Promise<void> {
  try {
    const rc = (req.run_context ?? {}) as Record<string, unknown>
    const capabilityId = _str(rc, 'capability_id', 'capabilityId')
    if (!capabilityId) return  // no governed capability → nothing to resolve

    const nodeId = _str(rc, 'workflow_node_id', 'workflowNodeId')
    const instanceId = _str(rc, 'workflow_instance_id', 'workflowInstanceId')
    const workItemId = _str(rc, 'work_item_id', 'workItemId')

    const ctx: GovernanceResolveContext = {
      capability_id: capabilityId,
      stage_key: req.stage_key,
      agent_role: req.agent_role,
      node_id: nodeId,
      workflow_id: _str(rc, 'workflow_id', 'workflowId'),
    }
    const overlay = await resolveGovernance(ctx)
    if (!overlay) return  // IAM unreachable / no governance → dispatch unchanged

    req.governance_overlay = overlay
    if (workItemId) {
      req.governance_waivers = await activeWaiverControlKeys(workItemId).catch(() => [])
    }

    // Snapshot for audit — runtime reads governance that applied at execution
    // time. Idempotent on (workItemId, workflowNodeId, overlayHash).
    const overlayHash = String((overlay as Record<string, unknown>).overlayHash ?? '')
    if (overlayHash) {
      const existing = await prisma.governanceOverlaySnapshot.findFirst({
        where: { workItemId: workItemId ?? null, workflowNodeId: nodeId ?? null, overlayHash },
      }).catch(() => null)
      if (!existing) {
        await prisma.governanceOverlaySnapshot.create({
          data: {
            workItemId: workItemId ?? null,
            workflowInstanceId: instanceId ?? null,
            workflowNodeId: nodeId ?? null,
            governedCapabilityId: capabilityId,
            overlayHash,
            resolvedOverlayJson: overlay as Prisma.InputJsonValue,
          },
        }).catch(() => undefined)
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[governance] enrich stage request failed (continuing without enforcement): ${(err as Error).message}`,
    )
  }
}
