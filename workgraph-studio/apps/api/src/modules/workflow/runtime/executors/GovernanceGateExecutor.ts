import { Prisma, type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
import { createReceipt, logEvent, publishOutbox } from '../../../../lib/audit'
import { resolveGovernance, type GovernanceResolveContext } from '../../../../lib/iam/client'
import { activeWaiverControlKeys } from '../../../governance/governance.router'
import { evaluateGovernanceBlock, decideGateStatus, type GovernanceBlock, type GovernanceOverlay } from './governance/evaluateBlock'
import { evaluateConfidenceGating, type ConfidenceGatingConfig } from './governance/confidenceGating'
import { resolveSatisfiedControls, makeEvidenceChecker, bindingsFromOverlay, controlsReferenced, type BindingMap, type ControlBinding } from './governance/resolveSatisfiedControls'
import { materializeRunEvidence } from './governance/materializeEvidencePack'
import { evaluateActiveGovernancePolicies } from '../../../governance/governance-policy.service'

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

type GateMode = 'HARD_BLOCK' | 'SOFT_WARN' | 'AUTOMATIC' | 'MANUAL_REVIEW'
type GateStatus = 'PASSED' | 'WARNED' | 'BLOCKED' | 'APPROVAL_REQUESTED' | 'SKIPPED'

type GateCheckStatus = 'SATISFIED' | 'WAIVED' | 'BLOCKED' | 'MISSING'
type GateCheck = {
  controlKey: string
  status: GateCheckStatus
  mode?: string
  reason?: string
  bindingType?: string
  source: 'context' | 'binding' | 'waiver' | 'missing'
}

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
    checks: GateCheck[]
    localControlCount?: number
    overlayControlCount?: number
    formalVerifierUsed?: boolean
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

function cfgJson(node: WorkflowNode, key: string): unknown {
  const value = cfgValue(node, key)
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

function cfgStringArray(node: WorkflowNode, key: string): string[] {
  return asStringArray(cfgValue(node, key))
}

export function normalizeGovernanceGateMode(value: string | undefined): GateMode {
  const raw = String(value ?? 'HARD_BLOCK').trim().toUpperCase()
  if (['SOFT', 'SOFT_WARN', 'WARN', 'WARNING'].includes(raw)) return 'SOFT_WARN'
  if (['AUTO', 'AUTOMATIC', 'AUTO_WAIVER'].includes(raw)) return 'AUTOMATIC'
  if (['MANUAL', 'MANUAL_REVIEW', 'HUMAN_REVIEW', 'HUMAN_APPROVAL', 'HUMAN_APPROVAL_REQUIRED'].includes(raw)) return 'MANUAL_REVIEW'
  return 'HARD_BLOCK'
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
  const raw = cfgJson(node, 'controlBindings')
  if (!isRecord(raw)) return {}
  const out: BindingMap = {}
  for (const [k, v] of Object.entries(raw)) {
    if (isRecord(v) && typeof v.type === 'string') out[k] = v as unknown as ControlBinding
  }
  return out
}

type LocalGateControl = {
  controlKey: string
  mode?: string
  reason?: string
  stageKey?: string
  binding?: ControlBinding
}

function toLocalControl(value: unknown): LocalGateControl | null {
  if (typeof value === 'string' && value.trim()) return { controlKey: value.trim(), mode: 'BLOCKING' }
  if (!isRecord(value)) return null
  const controlKey =
    typeof value.controlKey === 'string' ? value.controlKey.trim()
    : typeof value.evidenceKey === 'string' ? value.evidenceKey.trim()
    : typeof value.key === 'string' ? value.key.trim()
    : ''
  if (!controlKey) return null
  const rawBinding = isRecord(value.binding)
    ? value.binding
    : typeof value.type === 'string'
      ? value
      : undefined
  return {
    controlKey,
    mode: typeof value.mode === 'string' ? value.mode : 'BLOCKING',
    reason: typeof value.reason === 'string' ? value.reason : undefined,
    stageKey: typeof value.stageKey === 'string' ? value.stageKey : undefined,
    binding: rawBinding && typeof rawBinding.type === 'string' ? rawBinding as unknown as ControlBinding : undefined,
  }
}

export function localControlsFromConfig(node: WorkflowNode): LocalGateControl[] {
  const raw = cfgJson(node, 'gateControls') ?? cfgJson(node, 'controls') ?? cfgJson(node, 'requiredControls')
  const controls = Array.isArray(raw) ? raw.map(toLocalControl).filter((c): c is LocalGateControl => Boolean(c)) : []

  for (const artifact of cfgStringArray(node, 'requiredArtifacts')) {
    const key = `ARTIFACT:${artifact}`
    controls.push({
      controlKey: key,
      mode: 'BLOCKING',
      reason: `required artifact '${artifact}' was not approved or published`,
      binding: { type: 'artifact', artifactName: artifact },
    })
  }

  if (cfgBool(node, 'runFormalVerifier', false)) {
    controls.push({
      controlKey: 'FORMAL_VERIFICATION',
      mode: 'BLOCKING',
      reason: 'formal verifier found an unsafe workflow condition or could not prove the gate safe',
      binding: { type: 'formal' },
    })
  }

  const diffValidation = cfgJson(node, 'diffValidation')
  if (isRecord(diffValidation)) {
    controls.push({
      controlKey: 'DIFF_VS_DESIGN',
      mode: 'BLOCKING',
      reason: 'code diff does not satisfy the design contract',
      binding: { type: 'diff', diffValidation },
    })
  }

  const standardText = cfgString(node, 'standardText')
  const standardName = cfgString(node, 'standardName')
  const documentKey = cfgString(node, 'documentKey')
  if (standardText || standardName || documentKey) {
    controls.push({
      controlKey: `STANDARD:${standardName ?? 'document'}`,
      mode: 'BLOCKING',
      reason: 'document does not conform to the configured standard',
      binding: { type: 'standard', standardName, standardText, documentKey },
    })
  }

  const predicate = cfgJson(node, 'predicate')
  if (isRecord(predicate)) {
    controls.push({
      controlKey: cfgString(node, 'predicateControlKey') ?? 'CUSTOM_PREDICATE',
      mode: 'BLOCKING',
      reason: 'custom predicate did not pass',
      binding: { type: 'predicate', predicate: predicate as unknown as ControlBinding['predicate'] },
    })
  }

  return controls
}

export function localOverlayFromControls(controls: LocalGateControl[]): { overlay: GovernanceOverlay | null; bindings: BindingMap } {
  if (controls.length === 0) return { overlay: null, bindings: {} }
  const requiredEvidence = controls.map(c => ({
    evidenceKey: c.controlKey,
    mode: String(c.mode ?? 'BLOCKING').toUpperCase(),
    stageKey: c.stageKey,
    reason: c.reason,
  }))
  const bindings: BindingMap = {}
  for (const control of controls) if (control.binding) bindings[control.controlKey] = control.binding
  return {
    overlay: {
      effectiveMode: 'BLOCKING',
      requiredEvidence,
      blockingControls: [],
      overlayHash: `local:${controls.map(c => c.controlKey).sort().join('|')}`,
    },
    bindings,
  }
}

function mergeOverlays(localOverlay: GovernanceOverlay | null, resolvedOverlay: GovernanceOverlay | null): GovernanceOverlay | null {
  if (!localOverlay && !resolvedOverlay) return null
  if (!localOverlay) return resolvedOverlay
  if (!resolvedOverlay) return localOverlay
  return {
    ...localOverlay,
    ...resolvedOverlay,
    effectiveMode: resolvedOverlay.effectiveMode ?? localOverlay.effectiveMode,
    requiredEvidence: [
      ...(localOverlay.requiredEvidence ?? []),
      ...(resolvedOverlay.requiredEvidence ?? []),
    ],
    blockingControls: [
      ...(localOverlay.blockingControls ?? []),
      ...(resolvedOverlay.blockingControls ?? []),
    ],
    controlBindings: {
      ...(isRecord(localOverlay.controlBindings) ? localOverlay.controlBindings : {}),
      ...(isRecord(resolvedOverlay.controlBindings) ? resolvedOverlay.controlBindings : {}),
    },
  }
}

function gateChecks(
  overlay: GovernanceOverlay | null,
  bindings: BindingMap,
  satisfied: ReadonlySet<string>,
  waived: ReadonlySet<string>,
  blocked: GovernanceBlock[],
): GateCheck[] {
  const blockedByKey = new Map(blocked.map(b => [b.controlKey, b]))
  return controlsReferenced(overlay).map(controlKey => {
    const block = blockedByKey.get(controlKey)
    const binding = bindings[controlKey]
    if (waived.has(controlKey)) {
      return { controlKey, status: 'WAIVED', bindingType: binding?.type, source: 'waiver' }
    }
    if (satisfied.has(controlKey)) {
      return { controlKey, status: 'SATISFIED', bindingType: binding?.type, source: binding ? 'binding' : 'context' }
    }
    if (block) {
      return { controlKey, status: 'BLOCKED', mode: block.mode, reason: block.reason, bindingType: binding?.type, source: binding ? 'binding' : 'missing' }
    }
    return { controlKey, status: 'MISSING', bindingType: binding?.type, source: binding ? 'binding' : 'missing' }
  })
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
  const tenantId = instance.tenantId ?? undefined
  await withTenantDbTransaction(prisma, (tx) => Promise.all([
    tx.workflowNode.update({
      where: { id: node.id },
      data: { status: 'BLOCKED', completedAt: new Date() },
    }),
    tx.workflowInstance.update({
      where: { id: instance.id },
      data: {
        status: 'PAUSED',
        context: {
          ...((instance.context ?? {}) as Record<string, unknown>),
          _blockedByGovernanceGate: output.governanceGate,
        } as unknown as Prisma.InputJsonValue,
      },
    }),
    tx.workflowMutation.create({
        data: {
          instanceId: instance.id,
          nodeId: node.id,
        mutationType: isApproval ? 'GOVERNANCE_GATE_APPROVAL_REQUESTED' : 'GOVERNANCE_GATE_BLOCKED',
        beforeState: { status: node.status } as Prisma.InputJsonValue,
        afterState: output as unknown as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ]), tenantId)
  const eventId = await logEvent(eventType, 'WorkflowNode', node.id, actorId, { instanceId: instance.id, output })
  await createReceipt('GOVERNANCE_GATE_EVIDENCE', 'WorkflowNode', node.id, {
    instanceId: instance.id,
    nodeId: node.id,
    status: output.governanceGate.status,
    mode: output.governanceGate.mode,
    checks: output.governanceGate.checks,
    blocked: output.governanceGate.blocked,
  }, eventId).catch(() => undefined)
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
  const eventId = await logEvent(eventType, 'WorkflowNode', node.id, actorId, { instanceId: instance.id, output })
  await createReceipt('GOVERNANCE_GATE_EVIDENCE', 'WorkflowNode', node.id, {
    instanceId: instance.id,
    nodeId: node.id,
    status: output.governanceGate.status,
    mode: output.governanceGate.mode,
    checks: output.governanceGate.checks,
    blocked: output.governanceGate.blocked,
  }, eventId).catch(() => undefined)
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
  const tenantId = instance.tenantId ?? undefined
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const standard = cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard) ? cfg.standard as Record<string, unknown> : {}
  const quorumRaw = Number(cfg.quorumRequired ?? cfg.approvalQuorum ?? cfg.minVotes ?? standard.quorumRequired ?? standard.approvalQuorum ?? standard.minVotes ?? 1)
  const quorumRequired = Number.isFinite(quorumRaw) ? Math.min(100, Math.max(1, Math.trunc(quorumRaw))) : 1
  const adminOverride = cfg.adminOverride !== false
  const escalationPolicy = cfg.escalationPolicy && typeof cfg.escalationPolicy === 'object' && !Array.isArray(cfg.escalationPolicy)
    ? cfg.escalationPolicy as Record<string, unknown>
    : {}
  const firstAfterSeconds = Array.isArray(escalationPolicy.levels) ? Number((escalationPolicy.levels[0] as Record<string, unknown> | undefined)?.afterSeconds) : 0
  const waiverIds: string[] = []
  for (const b of blocked) {
    const existing = await withTenantDbTransaction(prisma, (tx) => tx.governanceWaiver
      .findFirst({ where: { workflowNodeId: node.id, controlKey: b.controlKey, status: 'REQUESTED' }, select: { id: true } }), tenantId)
      .catch(() => null)
    if (existing) {
      waiverIds.push(existing.id)
      continue
    }
    const w = await withTenantDbTransaction(prisma, (tx) => tx.governanceWaiver
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
      }), tenantId)
      .catch(() => null)
    if (w) waiverIds.push(w.id)
  }
  const existingAppr = await withTenantDbTransaction(prisma, (tx) => tx.approvalRequest
    .findFirst({ where: { instanceId: instance.id, nodeId: node.id, subjectType: 'WorkflowNode', subjectId: node.id, status: 'PENDING' }, select: { id: true } }), tenantId)
    .catch(() => null)
  if (existingAppr) return { waiverIds, approvalId: existingAppr.id }
  const appr = await withTenantDbTransaction(prisma, (tx) => tx.approvalRequest
    .create({
      data: {
        instanceId: instance.id,
        tenantId: instance.tenantId ?? null,
        nodeId: node.id,
        subjectType: 'WorkflowNode',
        subjectId: node.id,
        requestedById: actorId ?? instance.createdById ?? 'system',
        assignmentMode: 'ROLE_BASED',
        roleKey: 'governance',
        capabilityId: governingCapabilityId,
        quorumRequired,
        adminOverride,
        escalationPolicy: escalationPolicy as Prisma.InputJsonValue,
        ...(firstAfterSeconds > 0 ? { nextEscalationAt: new Date(Date.now() + firstAfterSeconds * 1000) } : {}),
        formData: { blocked } as unknown as Prisma.InputJsonValue,
      },
    }), tenantId)
    .catch(() => null)
  return { waiverIds, approvalId: appr?.id ?? undefined }
}

async function openManualApproval(
  instance: WorkflowInstance,
  node: WorkflowNode,
  output: GovernanceGateOutput,
  governingCapabilityId?: string,
  actorId?: string,
): Promise<string | undefined> {
  const tenantId = instance.tenantId ?? undefined
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const standard = cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard) ? cfg.standard as Record<string, unknown> : {}
  const quorumRaw = Number(cfg.quorumRequired ?? cfg.approvalQuorum ?? cfg.minVotes ?? standard.quorumRequired ?? standard.approvalQuorum ?? standard.minVotes ?? 1)
  const quorumRequired = Number.isFinite(quorumRaw) ? Math.min(100, Math.max(1, Math.trunc(quorumRaw))) : 1
  const escalationPolicy = cfg.escalationPolicy && typeof cfg.escalationPolicy === 'object' && !Array.isArray(cfg.escalationPolicy)
    ? cfg.escalationPolicy as Record<string, unknown>
    : {}
  const firstAfterSeconds = Array.isArray(escalationPolicy.levels) ? Number((escalationPolicy.levels[0] as Record<string, unknown> | undefined)?.afterSeconds) : 0
  const existing = await withTenantDbTransaction(prisma, (tx) => tx.approvalRequest
    .findFirst({
      where: {
        instanceId: instance.id,
        nodeId: node.id,
        subjectType: 'WorkflowNode',
        subjectId: node.id,
        status: 'PENDING',
      },
      select: { id: true },
    }), tenantId)
    .catch(() => null)
  if (existing) return existing.id
  const created = await withTenantDbTransaction(prisma, (tx) => tx.approvalRequest
    .create({
      data: {
        instanceId: instance.id,
        tenantId: instance.tenantId ?? null,
        nodeId: node.id,
        subjectType: 'WorkflowNode',
        subjectId: node.id,
        requestedById: actorId ?? instance.createdById ?? 'system',
        assignmentMode: 'ROLE_BASED',
        roleKey: 'governance',
        capabilityId: governingCapabilityId ?? null,
        quorumRequired,
        adminOverride: cfg.adminOverride !== false,
        escalationPolicy: escalationPolicy as Prisma.InputJsonValue,
        ...(firstAfterSeconds > 0 ? { nextEscalationAt: new Date(Date.now() + firstAfterSeconds * 1000) } : {}),
        formData: {
          governanceGate: output.governanceGate,
          message: 'Manual governance review is required before this workflow may proceed.',
        } as unknown as Prisma.InputJsonValue,
      },
    }), tenantId)
    .catch(() => null)
  return created?.id
}

export async function activateGovernanceGate(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<{ passed: boolean; output: GovernanceGateOutput }> {
  const context = (isRecord(instance.context) ? instance.context : {}) as Record<string, unknown>
  const mode = normalizeGovernanceGateMode(cfgString(node, 'mode'))
  const failClosed = cfgBool(node, 'failClosedOnResolveError', true)
  const capabilityId =
    cfgString(node, 'governingCapabilityId') ??
    cfgString(node, 'capabilityId') ??
    ctxStr(context, 'capability_id', 'capabilityId', 'governingCapabilityId')
  const workItemId = ctxStr(context, 'workItemId', 'work_item_id')
  const workflowId = ctxStr(context, 'workflowId', 'workflow_id')
  let policyEvaluationError: string | undefined
  const policyEvaluation = await evaluateActiveGovernancePolicies({
    capabilityId,
    workflowId: workflowId,
    workItemTypeKey: ctxStr(context, 'workItemTypeKey', 'work_item_type'),
    evidence: context,
    actorId: actorId ?? instance.createdById ?? 'system',
    instanceId: instance.id,
    nodeId: node.id,
    workItemId: ctxStr(context, 'workItemId', 'work_item_id'),
  }).catch((error: unknown) => {
    policyEvaluationError = error instanceof Error ? error.message : String(error)
    return { results: [], blocked: [], warned: [] }
  })
  const policyControls: LocalGateControl[] = policyEvaluation.blocked.flatMap(item => {
    const missing = Array.isArray(item.result.missing) ? item.result.missing.map(String) : []
    return missing.map(key => ({
      controlKey: `POLICY:${item.policy.id}:${key}`,
      mode: item.policy.mode,
      reason: `Governance policy '${item.policy.name}' requires evidence '${key}'`,
    }))
  })
  const localControls = [...localControlsFromConfig(node), ...policyControls]
  const local = localOverlayFromControls(localControls)

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
      checks: [],
      localControlCount: localControls.length,
      ...over,
    },
  })

  // An unavailable policy store must never look like an empty policy set for a
  // hard gate. Advisory/manual modes retain their configured behavior, but the
  // failure is kept visible in the gate output for operators and audit readers.
  if (policyEvaluationError && mode === 'HARD_BLOCK' && failClosed) {
    const blocked: GovernanceBlock[] = [{
      controlKey: 'GOVERNANCE_POLICY_RESOLVE',
      kind: 'control',
      mode: 'BLOCKING',
      reason: `active governance policies could not be evaluated: ${policyEvaluationError}`,
      waivable: false,
    }]
    const output = baseOut({
      status: 'BLOCKED',
      blocked,
      findings: blocked,
      note: 'governance policy evaluation failed; failing closed',
    })
    await blockNode(instance, node, output, actorId)
    return { passed: false, output }
  }

  // No governing capability and no local controls configured → nothing to enforce.
  if (!capabilityId && !local.overlay) {
    const output = baseOut({ status: 'SKIPPED', note: 'no governing capability configured' })
    await emitNonBlock('SKIPPED', instance, node, output, actorId)
    return { passed: true, output }
  }

  const ctx: GovernanceResolveContext | null = capabilityId
    ? {
        capability_id: capabilityId,
        node_id: node.id,
        workflow_id: workflowId,
        stage_key: cfgString(node, 'stageKey'),
        agent_role: cfgString(node, 'agentRole'),
      }
    : null
  const resolvedOverlay = ctx
    ? (await resolveGovernance(ctx).catch(() => null)) as GovernanceOverlay | null
    : null
  const overlay = mergeOverlays(local.overlay, resolvedOverlay)

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

  if (capabilityId && !resolvedOverlay && failClosed && mode === 'HARD_BLOCK') {
    const blocked: GovernanceBlock[] = [{
      controlKey: 'GOVERNANCE_RESOLVE',
      kind: 'control',
      mode: 'BLOCKING',
      reason: 'governance overlay could not be resolved (IAM unavailable); failing closed',
      waivable: false,
    }]
    const checks = gateChecks(overlay, { ...readBindingMap(node), ...local.bindings, ...bindingsFromOverlay(overlay) }, new Set(), new Set(), blocked)
    const output = baseOut({ status: 'BLOCKED', blocked, findings: blocked, checks })
    await blockNode(instance, node, output, actorId)
    return { passed: false, output }
  }

  const overlaySnapshotId = capabilityId
    ? await snapshotOverlay({
        workItemId,
        workflowInstanceId: instance.id,
        workflowNodeId: node.id,
        governedCapabilityId: capabilityId,
        overlay,
      })
    : undefined

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
  const bindings = { ...readBindingMap(node), ...local.bindings, ...bindingsFromOverlay(overlay) }
  const satisfied = await resolveSatisfiedControls(overlay, bindings, base, makeEvidenceChecker(instance, node, actorId))
  const waivedKeys = [
    ...(workItemId ? await activeWaiverControlKeys(workItemId, new Date(), instance.tenantId ?? undefined).catch(() => []) : []),
    ...(await nodeScopedWaiverKeys(node.id)),
  ]
  const waived = new Set(waivedKeys)

  const blocked = evaluateGovernanceBlock(overlay, satisfied, waived)
  const effectiveMode = String(overlay.effectiveMode ?? 'ADVISORY').toUpperCase()

  let status = (mode === 'MANUAL_REVIEW' ? 'APPROVAL_REQUESTED' : decideGateStatus(blocked, mode)) as GateStatus
  const checks = gateChecks(overlay, bindings, satisfied, waived, blocked)

  // Confidence-gated autonomy (opt-in, default inert). SAFETY INVARIANT: this can only
  // ever convert a MANUAL APPROVAL_REQUESTED into an auto PASS, and ONLY when
  // blocked.length === 0 — a real governance block (an unsatisfied REQUIRED/BLOCKING
  // control) can NEVER be auto-approved. The guard lives here in the caller, so the
  // resolver can't widen it. See docs/confidence-gated-autonomy.md.
  let autoApprovalEvidence: Record<string, unknown> | null = null
  if (status === 'APPROVAL_REQUESTED' && blocked.length === 0) {
    const verdict = evaluateConfidenceGating({
      config: cfgValue(node, 'confidenceGating') as ConfidenceGatingConfig | undefined,
      context,
    })
    if (verdict.autoApprove) {
      status = 'PASSED'
      autoApprovalEvidence = verdict.evidence
    } else if (verdict.shadowWouldApprove) {
      await logEvent('GovernanceGateWouldAutoApprove', 'WorkflowNode', node.id, actorId, {
        instanceId: instance.id, ...verdict.evidence,
      })
    }
  }

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
    evidenceRefs: checks.map(c => `${c.controlKey}:${c.status}${c.bindingType ? `:${c.bindingType}` : ''}`),
    checks,
    localControlCount: localControls.length,
    overlayControlCount: Math.max(0, controlsReferenced(overlay).length - localControls.length),
    formalVerifierUsed: checks.some(c => c.bindingType === 'formal'),
  }
  if (autoApprovalEvidence) gate.note = 'auto-approved by confidence-gating'
  if (policyEvaluation.warned.length > 0) gate.note = `${gate.note ? `${gate.note}; ` : ''}${policyEvaluation.warned.length} advisory governance policy warning(s)`
  if (policyEvaluationError) gate.note = `${gate.note ? `${gate.note}; ` : ''}governance policy evaluation failed: ${policyEvaluationError}`

  if (status === 'APPROVAL_REQUESTED') {
    if (mode === 'AUTOMATIC' && capabilityId) {
      const opened = await openWaiverApproval(instance, node, capabilityId, blocked, workItemId, actorId)
      gate.waiverRequestIds = opened.waiverIds
      gate.approvalRequestId = opened.approvalId
    } else {
      gate.approvalRequestId = await openManualApproval(instance, node, { governanceGate: gate }, capabilityId, actorId)
    }
  }
  const output: GovernanceGateOutput = { governanceGate: gate }

  // BLOCKED and APPROVAL_REQUESTED both pause the node (BLOCKED state, restartable).
  // For AUTOMATIC, approving a waiver calls restartNode → this gate re-evaluates
  // with the control now waived, so the node is never stuck.
  if (status === 'BLOCKED' || status === 'APPROVAL_REQUESTED') {
    await blockNode(instance, node, output, actorId)
    return { passed: false, output }
  }
  // Confidence-gated auto-approval — record a full-weight audit receipt (same as a human
  // approval: attributable, queryable). Only reached when the invariant above allowed it.
  if (autoApprovalEvidence) {
    await createReceipt('GOVERNANCE_GATE_AUTO_APPROVED', 'WorkflowNode', node.id, {
      instanceId: instance.id,
      governingCapabilityId: capabilityId,
      satisfied: [...satisfied],
      waived: [...waived],
      evidence: autoApprovalEvidence,
    })
    await logEvent('GovernanceGateAutoApproved', 'WorkflowNode', node.id, actorId, { instanceId: instance.id, ...autoApprovalEvidence })
    await publishOutbox('WorkflowNode', node.id, 'GovernanceGateAutoApproved', { instanceId: instance.id, nodeId: node.id })
  }
  await emitNonBlock(status === 'WARNED' ? 'WARNED' : 'PASSED', instance, node, output, actorId)
  return { passed: true, output }
}
