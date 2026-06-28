import { Prisma, type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import { resolveGovernance, type GovernanceResolveContext } from '../../../../lib/iam/client'
import { activeWaiverControlKeys } from '../../../governance/governance.router'
import { evaluateGovernanceBlock, decideGateStatus, type GovernanceBlock, type GovernanceOverlay } from './governance/evaluateBlock'
import { resolveSatisfiedControls, makeEvidenceChecker, bindingsFromOverlay, type BindingMap, type ControlBinding } from './governance/resolveSatisfiedControls'
import { materializeRunEvidence } from './governance/materializeEvidencePack'

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
type GateStatus = 'PASSED' | 'WARNED' | 'BLOCKED' | 'APPROVAL_REQUESTED' | 'SKIPPED'

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
    waiverRequestIds?: string[]
    approvalRequestId?: string
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

/** v2 control→evidence bindings from node config (`controlBindings`); v3 moves these into the overlay. */
function readBindingMap(node: WorkflowNode): BindingMap {
  const raw = cfgValue(node, 'controlBindings')
  if (!isRecord(raw)) return {}
  const out: BindingMap = {}
  for (const [k, v] of Object.entries(raw)) {
    if (isRecord(v) && typeof v.type === 'string') out[k] = v as unknown as ControlBinding
  }
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
  const isApproval = output.governanceGate.status === 'APPROVAL_REQUESTED'
  const eventType = isApproval ? 'GovernanceGateApprovalRequested' : 'GovernanceGateBlocked'
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
        mutationType: isApproval ? 'GOVERNANCE_GATE_APPROVAL_REQUESTED' : 'GOVERNANCE_GATE_BLOCKED',
        beforeState: { status: node.status } as Prisma.InputJsonValue,
        afterState: output as unknown as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ])
  await logEvent(eventType, 'WorkflowNode', node.id, actorId, { instanceId: instance.id, output })
  await publishOutbox('WorkflowNode', node.id, eventType, { instanceId: instance.id, nodeId: node.id, output })
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

/**
 * AUTOMATIC route — open a REQUESTED waiver per blocking control + one approval
 * routed to the governing capability. Idempotent on re-runs (dedupe by node).
 * The node is then paused as BLOCKED; approving a waiver calls restartNode, which
 * re-evaluates this gate with the control now waived.
 */
async function openWaiverApproval(
  instance: WorkflowInstance,
  node: WorkflowNode,
  governingCapabilityId: string,
  blocked: GovernanceBlock[],
  workItemId?: string,
  actorId?: string,
): Promise<{ waiverIds: string[]; approvalId?: string }> {
  const waiverIds: string[] = []
  for (const b of blocked) {
    const existing = await prisma.governanceWaiver
      .findFirst({ where: { workflowNodeId: node.id, controlKey: b.controlKey, status: 'REQUESTED' }, select: { id: true } })
      .catch(() => null)
    if (existing) {
      waiverIds.push(existing.id)
      continue
    }
    const w = await prisma.governanceWaiver
      .create({
        data: {
          workflowInstanceId: instance.id,
          workflowNodeId: node.id,
          workItemId: workItemId ?? null,
          controlKey: b.controlKey,
          reason: b.reason,
          status: 'REQUESTED',
          requestedBy: actorId ?? null,
        },
      })
      .catch(() => null)
    if (w) waiverIds.push(w.id)
  }
  const existingAppr = await prisma.approvalRequest
    .findFirst({ where: { instanceId: instance.id, nodeId: node.id, subjectType: 'WorkflowNode', subjectId: node.id, status: 'PENDING' }, select: { id: true } })
    .catch(() => null)
  if (existingAppr) return { waiverIds, approvalId: existingAppr.id }
  const appr = await prisma.approvalRequest
    .create({
      data: {
        instanceId: instance.id,
        nodeId: node.id,
        subjectType: 'WorkflowNode',
        subjectId: node.id,
        requestedById: actorId ?? instance.createdById ?? 'system',
        assignmentMode: 'ROLE_BASED',
        roleKey: 'governance',
        capabilityId: governingCapabilityId,
        formData: { blocked } as unknown as Prisma.InputJsonValue,
      },
    })
    .catch(() => null)
  return { waiverIds, approvalId: appr?.id ?? undefined }
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

  // Optional: mirror the run's evidence (DB source-of-truth) to the work-item git
  // branch before evaluating, so the EVIDENCE_PACK_* controls verify a freshly
  // materialized pack. This is the "at-gate" materialization option (per-stage,
  // while each sandbox is live, is the richer alternative). Opt-in per node.
  if (cfgBool(node, 'materializeEvidence', false)) {
    const manifest = await materializeRunEvidence(instance).catch(() => null)
    if (manifest) {
      context._evidenceManifest = manifest
      ;(instance as { context: unknown }).context = context
    }
  }

  // v1 base (context-stamped) ∪ v2 evidence-bound controls (receipts/evaluators/formal/artifacts).
  const base = collectSatisfied(context, node)
  // Bindings: node config is the fallback; the IAM overlay (governing body) wins.
  const bindings = { ...readBindingMap(node), ...bindingsFromOverlay(overlay) }
  const satisfied = await resolveSatisfiedControls(overlay, bindings, base, makeEvidenceChecker(instance, node, actorId))
  const waivedKeys = [
    ...(workItemId ? await activeWaiverControlKeys(workItemId).catch(() => []) : []),
    ...(await nodeScopedWaiverKeys(node.id)),
  ]
  const waived = new Set(waivedKeys)

  const blocked = evaluateGovernanceBlock(overlay, satisfied, waived)
  const effectiveMode = String(overlay.effectiveMode ?? 'ADVISORY').toUpperCase()

  const status = decideGateStatus(blocked, mode) as GateStatus

  const gate: GovernanceGateOutput['governanceGate'] = {
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
  }

  if (status === 'APPROVAL_REQUESTED') {
    const opened = await openWaiverApproval(instance, node, capabilityId, blocked, workItemId, actorId)
    gate.waiverRequestIds = opened.waiverIds
    gate.approvalRequestId = opened.approvalId
  }
  const output: GovernanceGateOutput = { governanceGate: gate }

  // BLOCKED and APPROVAL_REQUESTED both pause the node (BLOCKED state, restartable).
  // For AUTOMATIC, approving a waiver calls restartNode → this gate re-evaluates
  // with the control now waived, so the node is never stuck.
  if (status === 'BLOCKED' || status === 'APPROVAL_REQUESTED') {
    await blockNode(instance, node, output, actorId)
    return { passed: false, output }
  }
  await emitNonBlock(status === 'WARNED' ? 'WARNED' : 'PASSED', instance, node, output, actorId)
  return { passed: true, output }
}
