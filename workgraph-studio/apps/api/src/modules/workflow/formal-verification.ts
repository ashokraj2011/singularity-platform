import { Prisma, type Workflow, type WorkflowDesignEdge, type WorkflowDesignNode, type WorkflowEdge, type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { config } from '../../config'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'
import { AppError, NotFoundError } from '../../lib/errors'
import { createReceipt, logEvent, publishOutbox } from '../../lib/audit'
import { readUpstreamJsonBody, upstreamSnippet } from '../../lib/upstream-json'

export const FORMAL_DISABLED_CODE = 'FORMAL_VERIFICATION_DISABLED'

type FormalGraphNode = Pick<WorkflowDesignNode | WorkflowNode, 'id' | 'label' | 'nodeType' | 'config'>
type FormalGraphEdge = Pick<WorkflowDesignEdge | WorkflowEdge, 'id' | 'sourceNodeId' | 'targetNodeId' | 'edgeType' | 'label' | 'condition'>

type FormalPayload = {
  scope: string
  facts: Record<string, unknown>
  constraints: Array<Record<string, unknown>>
  query: Record<string, unknown>
  options: Record<string, unknown>
  artifactRefs: Array<Record<string, unknown>>
  metadata: Record<string, unknown>
  capabilityId?: string | null
  workflowId?: string | null
  workflowInstanceId?: string | null
}

export function formalVerificationEnabled(): boolean {
  return config.FORMAL_VERIFICATION_ENABLED === true
}

export function formalDisabledPayload(entity: 'workflow' | 'workflow_run', id: string) {
  return {
    code: FORMAL_DISABLED_CODE,
    message: 'Formal verification is disabled at the platform level. Set FORMAL_VERIFICATION_ENABLED=true and restart services to enable Governance Path Analyzer.',
    entity,
    id,
    enabled: false,
  }
}

function assertFormalEnabled(entity: 'workflow' | 'workflow_run', id: string): void {
  if (!formalVerificationEnabled()) {
    throw new AppError(formalDisabledPayload(entity, id).message, FORMAL_DISABLED_CODE, 409)
  }
}

function textIncludes(node: FormalGraphNode, pattern: RegExp): boolean {
  return pattern.test(`${node.label} ${node.nodeType} ${JSON.stringify(node.config ?? {})}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cfgValue(node: FormalGraphNode, key: string): unknown {
  const cfg = isRecord(node.config) ? node.config : {}
  const standard = isRecord(cfg.standard) ? cfg.standard : {}
  return cfg[key] ?? standard[key]
}

function inferGraphFacts(nodes: FormalGraphNode[], edges: FormalGraphEdge[]) {
  const hasGitPush = nodes.some((n) => n.nodeType === 'GIT_PUSH')
  const hasWorkbench = nodes.some((n) => n.nodeType === 'WORKBENCH_TASK')
  const hasWorkItem = nodes.some((n) => n.nodeType === 'WORK_ITEM')
  const hasEvalGate = nodes.some((n) => n.nodeType === 'EVAL_GATE')
  const hasFormalGate = nodes.some((n) => {
    if (n.nodeType !== 'POLICY_CHECK') return false
    const engine = String(cfgValue(n, 'engine') ?? cfgValue(n, 'policyEngine') ?? '').toLowerCase()
    return engine === 'formal_verifier' || engine === 'formal-verifier'
  })
  const approvalNodes = nodes.filter((n) => n.nodeType === 'APPROVAL' || n.nodeType === 'HUMAN_TASK')
  const hasQaApproval = approvalNodes.some((n) => textIncludes(n, /qa|quality|test/i))
  const hasSecurityApproval = approvalNodes.some((n) => textIncludes(n, /security|risk|threat|vulnerab/i))
  const hasFinalApproval = approvalNodes.some((n) => textIncludes(n, /final|sign.?off|approval|approve/i))
  const hasDeploymentGate = nodes.some((n) => textIncludes(n, /deploy|release|git.?push|production/i))
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodeTypes: Array.from(new Set(nodes.map((n) => String(n.nodeType)))).sort(),
    gitPushPresent: hasGitPush,
    workbenchPresent: hasWorkbench,
    workItemPresent: hasWorkItem,
    evalGatePresent: hasEvalGate,
    formalGatePresent: hasFormalGate,
    deploymentGatePresent: hasDeploymentGate || hasGitPush,
    qaApprovalPresent: hasQaApproval,
    securityApprovalPresent: hasSecurityApproval,
    finalApprovalPresent: hasFinalApproval,
    approvalCount: approvalNodes.length,
    graph: {
      nodes: nodes.map((n) => ({ id: n.id, label: n.label, nodeType: n.nodeType })),
      edges: edges.map((e) => ({ id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId, edgeType: e.edgeType, label: e.label })),
    },
  }
}

function baseConstraints() {
  return [
    {
      id: 'deployment_requires_qa',
      severity: 'HIGH',
      description: 'Production release or git push must not be reachable without a QA/test approval gate.',
      expr: {
        op: 'IMPLIES',
        if: { field: 'deploymentGatePresent', op: '==', value: true },
        then: { field: 'qaApprovalPresent', op: '==', value: true },
      },
    },
    {
      id: 'deployment_requires_final_approval',
      severity: 'HIGH',
      description: 'Deployment path must have a human final approval/sign-off gate.',
      expr: {
        op: 'IMPLIES',
        if: { field: 'deploymentGatePresent', op: '==', value: true },
        then: { field: 'finalApprovalPresent', op: '==', value: true },
      },
    },
    {
      id: 'workbench_outputs_require_approval',
      severity: 'MEDIUM',
      description: 'Workbench-driven delivery should include a human approval gate before downstream promotion.',
      expr: {
        op: 'IMPLIES',
        if: { field: 'workbenchPresent', op: '==', value: true },
        then: { field: 'finalApprovalPresent', op: '==', value: true },
      },
    },
  ]
}

function unsafeQuery() {
  return {
    op: 'OR',
    args: [
      {
        op: 'AND',
        args: [
          { field: 'deploymentGatePresent', op: '==', value: true },
          { field: 'qaApprovalPresent', op: '==', value: false },
        ],
      },
      {
        op: 'AND',
        args: [
          { field: 'deploymentGatePresent', op: '==', value: true },
          { field: 'finalApprovalPresent', op: '==', value: false },
        ],
      },
    ],
  }
}

function verifierMessage(parsed: Record<string, unknown>, fallback: string): string {
  const detail = parsed.detail as Record<string, unknown> | string | undefined
  if (typeof detail === 'string') return detail
  if (isRecord(detail) && typeof detail.message === 'string' && detail.message.trim()) return detail.message.trim()
  if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim()
  return fallback
}

function verifierCode(parsed: Record<string, unknown>, fallback: string): string {
  const detail = parsed.detail as Record<string, unknown> | string | undefined
  if (isRecord(detail) && typeof detail.code === 'string' && detail.code.trim()) return detail.code.trim()
  if (typeof parsed.code === 'string' && parsed.code.trim()) return parsed.code.trim()
  return fallback
}

async function readVerifierJsonObject(res: Response, source: string): Promise<{
  parsed: Record<string, unknown>
  raw: string
  invalidReason?: string
}> {
  const body = await readUpstreamJsonBody(res)
  if (!body.raw.trim()) return { parsed: {}, raw: body.raw }
  if (body.parseError) return { parsed: { message: upstreamSnippet(body.raw, 700) }, raw: body.raw, invalidReason: body.parseError }
  if (isRecord(body.data)) return { parsed: body.data, raw: body.raw }
  return { parsed: { message: `${source} returned a non-object JSON response` }, raw: body.raw, invalidReason: 'non-object JSON response' }
}

async function callVerifier(path: string, payload: FormalPayload): Promise<Record<string, unknown>> {
  const url = `${config.FORMAL_VERIFIER_URL.replace(/\/+$/, '')}${path}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await readVerifierJsonObject(res, 'Formal verifier')
  if (!res.ok) {
    const message = verifierMessage(body.parsed, `Formal verifier returned HTTP ${res.status}`)
    throw new AppError(message, verifierCode(body.parsed, 'FORMAL_VERIFIER_ERROR'), res.status)
  }
  if (body.invalidReason) {
    const snippet = upstreamSnippet(body.raw, 700)
    throw new AppError(
      `Formal verifier returned invalid JSON for ${path}: ${body.invalidReason}${snippet ? `: ${snippet}` : ''}`,
      'FORMAL_VERIFIER_BAD_RESPONSE',
      502,
    )
  }
  return body.parsed
}

async function recordFormalEvent(kind: string, entityType: string, entityId: string, actorId: string | undefined, payload: Record<string, unknown>) {
  const eventId = await logEvent(kind, entityType, entityId, actorId, payload)
  await publishOutbox(entityType, entityId, kind, { ...payload, actorId })
  return eventId
}

function buildPayload(input: {
  scope: string
  workflow?: Workflow
  instance?: WorkflowInstance
  nodes: FormalGraphNode[]
  edges: FormalGraphEdge[]
  actorId?: string
  nodeId?: string
  extraFacts?: Record<string, unknown>
}) {
  const facts = {
    ...inferGraphFacts(input.nodes, input.edges),
    ...(input.extraFacts ?? {}),
  }
  return {
    scope: input.scope,
    facts,
    constraints: baseConstraints(),
    query: unsafeQuery(),
    options: { timeoutMs: Number(process.env.FORMAL_VERIFICATION_TIMEOUT_MS ?? 3000) },
    artifactRefs: [],
    metadata: {
      requestedBy: input.actorId,
      nodeId: input.nodeId,
      workflowName: input.workflow?.name ?? input.instance?.name,
      generatedBy: 'workgraph-api',
    },
    capabilityId: input.workflow?.capabilityId ?? undefined,
    workflowId: input.workflow?.id ?? input.instance?.templateId ?? undefined,
    workflowInstanceId: input.instance?.id ?? undefined,
  } satisfies FormalPayload
}

export async function analyzeWorkflowTemplate(templateId: string, actorId?: string) {
  assertFormalEnabled('workflow', templateId)
  const workflow = await prisma.workflow.findUnique({
    where: { id: templateId },
    include: { designNodes: true, designEdges: true },
  })
  if (!workflow) throw new NotFoundError('Workflow template', templateId)
  const payload = buildPayload({
    scope: 'workflow_template',
    workflow,
    nodes: workflow.designNodes,
    edges: workflow.designEdges,
    actorId,
  })
  await recordFormalEvent('formal_verification.requested', 'Workflow', templateId, actorId, payload)
  const result = await callVerifier('/api/v1/verification/workflows/analyze', payload)
  const eventId = await recordFormalEvent('formal_verification.completed', 'Workflow', templateId, actorId, { payload, result })
  await createReceipt('FORMAL_VERIFICATION', 'Workflow', templateId, { payload, result }, eventId)
  if (result.result === 'SAT') {
    await recordFormalEvent('formal_verification.violation_found', 'Workflow', templateId, actorId, { payload, result })
  } else if (result.result === 'UNKNOWN') {
    await recordFormalEvent('formal_verification.unknown', 'Workflow', templateId, actorId, { payload, result })
  }
  return { payload, result }
}

export async function analyzeWorkflowInstance(instanceId: string, actorId?: string, nodeId?: string, tenantId?: string) {
  assertFormalEnabled('workflow_run', instanceId)
  const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({
    where: { id: instanceId },
    include: { template: true, nodes: true, edges: true },
  }), tenantId)
  if (!instance) throw new NotFoundError('Workflow run', instanceId)
  const payload = buildPayload({
    scope: 'workflow_instance',
    workflow: instance.template ?? undefined,
    instance,
    nodes: instance.nodes,
    edges: instance.edges,
    actorId,
    nodeId,
    extraFacts: { runStatus: instance.status },
  })
  await recordFormalEvent('formal_verification.requested', 'WorkflowInstance', instanceId, actorId, payload)
  const result = await callVerifier('/api/v1/verification/workflows/analyze', payload)
  const eventId = await recordFormalEvent('formal_verification.completed', 'WorkflowInstance', instanceId, actorId, { payload, result })
  await createReceipt('FORMAL_VERIFICATION', 'WorkflowInstance', instanceId, { payload, result }, eventId)
  if (result.result === 'SAT') {
    await recordFormalEvent('formal_verification.violation_found', 'WorkflowInstance', instanceId, actorId, { payload, result })
  } else if (result.result === 'UNKNOWN') {
    await recordFormalEvent('formal_verification.unknown', 'WorkflowInstance', instanceId, actorId, { payload, result })
  }
  return { payload, result }
}

export async function recordFormalDisabledSkip(instance: WorkflowInstance, node: WorkflowNode, actorId?: string) {
  const payload = {
    code: FORMAL_DISABLED_CODE,
    message: 'Formal verifier gate skipped because FORMAL_VERIFICATION_ENABLED=false.',
    workflowInstanceId: instance.id,
    workflowNodeId: node.id,
    nodeLabel: node.label,
    nodeType: node.nodeType,
  }
  const eventId = await recordFormalEvent('formal_verification.disabled_skipped', 'WorkflowNode', node.id, actorId, payload)
  await createReceipt('FORMAL_VERIFICATION_DISABLED', 'WorkflowNode', node.id, payload, eventId)
  return payload
}

export function shouldBlockFormalResult(result: Record<string, unknown>, configInput: unknown) {
  const cfg = (configInput && typeof configInput === 'object' && !Array.isArray(configInput))
    ? configInput as Record<string, unknown>
    : {}
  const standard = (cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard))
    ? cfg.standard as Record<string, unknown>
    : {}
  const resultKind = String(result.result ?? 'UNKNOWN').toUpperCase()
  const profile = String(cfg.profile ?? standard.profile ?? cfg.verificationProfile ?? standard.verificationProfile ?? 'blocking').toLowerCase()
  if (resultKind === 'SAT') return true
  if (resultKind === 'UNKNOWN' && ['blocking', 'production', 'fail_closed'].includes(profile)) return true
  return false
}

export function asPrismaJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}
