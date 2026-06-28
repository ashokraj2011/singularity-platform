import { Prisma, type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import { resolveGovernance, type GovernanceResolveContext } from '../../../../lib/iam/client'
import { activeWaiverControlKeys } from '../../../governance/governance.router'
import { evaluateGovernanceBlock, type GovernanceBlock, type GovernanceOverlay } from './governance/evaluateBlock'

/**
 * GOVERNANCE_GATE executor (Capability Governance Gate, v1).
 *
 * A graph-node surface over the existing G4 governance model: it RESOLVES the
 * IAM-managed overlay for a governing capability, computes the SATISFIED control
 * set from run evidence, applies active WAIVERS, EVALUATES the unsatisfied
 * REQUIRED/BLOCKING controls (parity with CF's in-stage gate), then DECIDES
 * pass / warn / block per the node's mode. Blocking instructions are owned by the
 * governing body via IAM — the node only references a capability.
 *
 * v1 satisfied-evidence sources: control keys stamped into the run context by
 * upstream stages/nodes (`_satisfiedEvidence` / `_governanceEvidence`) plus an
 * explicit node-level `preSatisfiedControls`. (v2 adds receipts / evaluators /
 * formal / artifact / diff bindings + the AUTOMATIC approval-waiver route.)
 */

type GateMode = 'HARD_BLOCK' | 'SOFT_WARN' | 'AUTOMATIC'
type GateStatus = 'PASSED' | 'WARNED' | 'BLOCKED' | 'SKIPPED'

type GovernanceGateOutput = {
  governanceGate: {
    status: GateStatus
    mode: GateMode
    effectiveMode: string
    governingCapabilityId?: string
    overlaySnapshotId?: string
    satisfied: string[]
    waived: string[]
    blocked: GovernanceBlock[]
    findings: GovernanceBlock[]
    evidenceRefs: string[]
    note?: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cfgValue(node: WorkflowNode, key: string): unknown {
  const cfg = isRecord(node.config) ? node.config : {}
  const standard = isRecord(cfg.standard) ? cfg.standard : {}
  return cfg[key] ?? standard[key]
}

function cfgString(node: WorkflowNode, key: string): string | undefined {
  const value = cfgValue(node, key)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function cfgBool(node: WorkflowNode, key: string, fallback: boolean): boolean {
  const value = cfgValue(node, key)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value === 'true'
  return fallback
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

function cfgStringArray(node: WorkflowNode, key: string): string[] {
  return asStringArray(cfgValue(node, key))
}

function ctxStr(context: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = context[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/** v1 satisfied-control set: context-stamped evidence keys + node pre-satisfied. */
function collectSatisfied(context: Record<string, unknown>, node: WorkflowNode): Set<string> {
  const out = new Set<string>()
  for (const key of ['_satisfiedEvidence', 'satisfiedEvidence', '_governanceEvidence', 'governanceEvidence']) {
    for (const k of asStringArray(context[key])) out.add(k)
  }
  for (const k of cfgStringArray(node, 'preSatisfiedControls')) out.add(k)
  return out
}

/** APPROVED, unexpired waivers scoped to this specific node (complements work-item waivers). */
async function nodeScopedWaiverKeys(nodeId: string): Promise<string[]> {
  const rows = await prisma.governanceWaiver
    .findMany({
      where: { workflowNodeId: nodeId, status: 'APPROVED', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { controlKey: true },
    })
    .catch(() => [] as Array<{ controlKey: string }>)
  return [...new Set(rows.map(r => r.controlKey))]
}

/** Idempotent overlay snapshot — mirrors enrichStageRequestWithGovernance / governance.router. */
async function snapshotOverlay(args: {
  workItemId?: string
  workflowInstanceId?: string
  workflowNodeId: string
  governedCapabilityId: string
  overlay: GovernanceOverlay
}): Promise<string | undefined> {
  const overlayHash = String(args.overlay.overlayHash ?? '')
  if (!overlayHash) return undefined
  const existing = await prisma.governanceOverlaySnapshot
    .findFirst({ where: { workItemId: args.workItemId ?? null, workflowNodeId: args.workflowNodeId, overlayHash } })
    .catch(() => null)
  if (existing) return existing.id
  const created = await prisma.governanceOverlaySnapshot
    .create({
      data: {
        workItemId: args.workItemId ?? null,
        workflowInstanceId: args.workflowInstanceId ?? null,
        workflowNodeId: args.workflowNodeId,
        governedCapabilityId: args.governedCapabilityId,
        overlayHash,
        resolvedOverlayJson: args.overlay as unknown as Prisma.InputJsonValue,
      },
    })
    .catch(() => null)
  return created?.id
}

async function blockNode(
  instance: WorkflowInstance,
  node: WorkflowNode,
  output: GovernanceGateOutput,
  actorId?: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.workflowNode.update({
      where: { id: node.id },
      data: { status: 'BLOCKED', completedAt: new Date() },
    }),
    prisma.workflowInstance.update({
      where: { id: instance.id },
      data: {
        status: 'PAUSED',
        context: {
          ...((instance.context ?? {}) as Record<string, unknown>),
          _blockedByGovernanceGate: output.governanceGate,
        } as unknown as Prisma.InputJsonValue,
      },
    }),
    prisma.workflowMutation.create({
      data: {
        instanceId: instance.id,
        nodeId: node.id,
        mutationType: 'GOVERNANCE_GATE_BLOCKED',
        beforeState: { status: node.status } as Prisma.InputJsonValue,
        afterState: output as unknown as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ])
  await logEvent('GovernanceGateBlocked', 'WorkflowNode', node.id, actorId, { instanceId: instance.id, output })
  await publishOutbox('WorkflowNode', node.id, 'GovernanceGateBlocked', { instanceId: instance.id, nodeId: node.id, output })
}

async function emitNonBlock(
  status: 'PASSED' | 'WARNED' | 'SKIPPED',
  instance: WorkflowInstance,
  node: WorkflowNode,
  output: GovernanceGateOutput,
  actorId?: string,
): Promise<void> {
  const eventType = status === 'WARNED' ? 'GovernanceGateWarned' : 'GovernanceGatePassed'
  await logEvent(eventType, 'WorkflowNode', node.id, actorId, { instanceId: instance.id, output })
  await publishOutbox('WorkflowNode', node.id, eventType, { instanceId: instance.id, nodeId: node.id, output })
}

export async function activateGovernanceGate(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<{ passed: boolean; output: GovernanceGateOutput }> {
  const context = (isRecord(instance.context) ? instance.context : {}) as Record<string, unknown>
  const mode = ((cfgString(node, 'mode') ?? 'HARD_BLOCK').toUpperCase() as GateMode)
  const failClosed = cfgBool(node, 'failClosedOnResolveError', true)
  const capabilityId =
    cfgString(node, 'governingCapabilityId') ??
    cfgString(node, 'capabilityId') ??
    ctxStr(context, 'capability_id', 'capabilityId', 'governingCapabilityId')
  const workItemId = ctxStr(context, 'workItemId', 'work_item_id')
  const workflowId = ctxStr(context, 'workflowId', 'workflow_id')

  const baseOut = (over: Partial<GovernanceGateOutput['governanceGate']>): GovernanceGateOutput => ({
    governanceGate: {
      status: 'PASSED',
      mode,
      effectiveMode: 'ADVISORY',
      governingCapabilityId: capabilityId,
      satisfied: [],
      waived: [],
      blocked: [],
      findings: [],
      evidenceRefs: [],
      ...over,
    },
  })

  // No governing capability configured → nothing to enforce.
  if (!capabilityId) {
    const output = baseOut({ status: 'SKIPPED', note: 'no governing capability configured' })
    await emitNonBlock('SKIPPED', instance, node, output, actorId)
    return { passed: true, output }
  }

  const ctx: GovernanceResolveContext = {
    capability_id: capabilityId,
    node_id: node.id,
    workflow_id: workflowId,
    stage_key: cfgString(node, 'stageKey'),
    agent_role: cfgString(node, 'agentRole'),
  }
  const overlay = (await resolveGovernance(ctx).catch(() => null)) as GovernanceOverlay | null

  // Overlay unresolved (IAM unavailable / no governance attached).
  if (!overlay) {
    if (mode === 'HARD_BLOCK' && failClosed) {
      const blocked: GovernanceBlock[] = [{
        controlKey: 'GOVERNANCE_RESOLVE',
        kind: 'control',
        mode: 'BLOCKING',
        reason: 'governance overlay could not be resolved (IAM unavailable); failing closed',
        waivable: false,
      }]
      const output = baseOut({ status: 'BLOCKED', blocked, findings: blocked })
      await blockNode(instance, node, output, actorId)
      return { passed: false, output }
    }
    const output = baseOut({ status: 'SKIPPED', note: 'governance overlay unavailable; advisory (fail-open)' })
    await emitNonBlock('SKIPPED', instance, node, output, actorId)
    return { passed: true, output }
  }

  const overlaySnapshotId = await snapshotOverlay({
    workItemId,
    workflowInstanceId: instance.id,
    workflowNodeId: node.id,
    governedCapabilityId: capabilityId,
    overlay,
  })

  const satisfied = collectSatisfied(context, node)
  const waivedKeys = [
    ...(workItemId ? await activeWaiverControlKeys(workItemId).catch(() => []) : []),
    ...(await nodeScopedWaiverKeys(node.id)),
  ]
  const waived = new Set(waivedKeys)

  const blocked = evaluateGovernanceBlock(overlay, satisfied, waived)
  const effectiveMode = String(overlay.effectiveMode ?? 'ADVISORY').toUpperCase()

  let status: GateStatus
  let passed: boolean
  if (blocked.length === 0) {
    status = 'PASSED'
    passed = true
  } else if (mode === 'SOFT_WARN') {
    status = 'WARNED'
    passed = true
  } else {
    // HARD_BLOCK (default); AUTOMATIC falls through to block in v1 (v2 = approval/waiver route).
    status = 'BLOCKED'
    passed = false
  }

  const output: GovernanceGateOutput = {
    governanceGate: {
      status,
      mode,
      effectiveMode,
      governingCapabilityId: capabilityId,
      overlaySnapshotId,
      satisfied: [...satisfied],
      waived: [...waived],
      blocked,
      findings: blocked,
      evidenceRefs: [],
    },
  }

  if (status === 'BLOCKED') {
    await blockNode(instance, node, output, actorId)
  } else {
    await emitNonBlock(status === 'WARNED' ? 'WARNED' : 'PASSED', instance, node, output, actorId)
  }
  return { passed, output }
}
