// VERIFIER node — a workflow stage that runs the verifier agent on the documents
// produced by the immediately-preceding stage(s) and BLOCKS the run (node BLOCKED,
// instance PAUSED, reason in context._blockedByVerifier) when any document fails
// the standards. Mirrors EvalGateExecutor's advance-on-pass / block-on-fail shape.
import { Prisma, type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import { runVerification, type Verdict } from '../../../consumable/verify.service'

type VerifierDoc = { id: string; name: string; passed: boolean; findings: string[]; rationale?: string }
type VerifierOutput = {
  verifier: {
    status: 'PASSED' | 'BLOCKED'
    total: number
    failed: number
    documents: VerifierDoc[]
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
  const v = cfgValue(node, key)
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
function cfgBool(node: WorkflowNode, key: string, fallback: boolean): boolean {
  const v = cfgValue(node, key)
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v === 'true'
  return fallback
}
function cfgStringArray(node: WorkflowNode, key: string): string[] {
  const v = cfgValue(node, key)
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

async function blockNode(instance: WorkflowInstance, node: WorkflowNode, output: VerifierOutput, actorId?: string): Promise<void> {
  await prisma.$transaction([
    prisma.workflowNode.update({ where: { id: node.id }, data: { status: 'BLOCKED', completedAt: new Date() } }),
    prisma.workflowInstance.update({
      where: { id: instance.id },
      data: {
        status: 'PAUSED',
        context: {
          ...((instance.context ?? {}) as Record<string, unknown>),
          _blockedByVerifier: output.verifier,
        } as Prisma.InputJsonValue,
      },
    }),
    prisma.workflowMutation.create({
      data: {
        instanceId: instance.id,
        nodeId: node.id,
        mutationType: 'VERIFIER_BLOCKED',
        beforeState: { status: node.status } as Prisma.InputJsonValue,
        afterState: output as unknown as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ])
  await logEvent('VerifierBlocked', 'WorkflowNode', node.id, actorId, { instanceId: instance.id, output })
  await publishOutbox('WorkflowNode', node.id, 'VerifierBlocked', { instanceId: instance.id, nodeId: node.id, output })
}

type Doc = { id: string; name: string; instanceId: string | null; formData: unknown }
const SELECT = { id: true, name: true, instanceId: true, formData: true } as const

function applyFilter(docs: Doc[], nameFilter: string[]): Doc[] {
  // Skip internal markers (e.g. _copilot_questions); apply an optional name filter.
  return docs.filter(d =>
    !d.name.startsWith('_') &&
    (nameFilter.length === 0 || nameFilter.some(n => d.name.toLowerCase().includes(n.toLowerCase()))),
  )
}

// scope PRIOR (default): documents produced by the node(s) immediately upstream.
async function priorDocuments(instanceId: string, nodeId: string, nameFilter: string[]): Promise<Doc[]> {
  const edges = await prisma.workflowEdge.findMany({ where: { targetNodeId: nodeId }, select: { sourceNodeId: true } })
  const sourceIds = edges.map(e => e.sourceNodeId).filter((id): id is string => Boolean(id))
  if (sourceIds.length === 0) return []
  return applyFilter(await prisma.consumable.findMany({ where: { instanceId, nodeId: { in: sourceIds } }, select: SELECT }), nameFilter)
}

// scope ALL: every document produced anywhere in the run (for a single gate that
// verifies the whole SDLC's output before, e.g., GIT_PUSH).
async function allDocuments(instanceId: string, nameFilter: string[]): Promise<Doc[]> {
  return applyFilter(await prisma.consumable.findMany({ where: { instanceId }, select: SELECT }), nameFilter)
}

export async function activateVerifier(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<{ passed: boolean; output: VerifierOutput }> {
  const criteria = cfgString(node, 'criteria') ?? cfgString(node, 'verificationPolicy')
  const nameFilter = cfgStringArray(node, 'documentNames')
  const requireDocuments = cfgBool(node, 'requireDocuments', false)
  const scope = (cfgString(node, 'scope') ?? 'PRIOR').toUpperCase()
  const userId = actorId ?? 'verifier-node'

  const docs = scope === 'ALL'
    ? await allDocuments(instance.id, nameFilter)
    : await priorDocuments(instance.id, node.id, nameFilter)

  if (docs.length === 0) {
    const passed = !requireDocuments
    const output: VerifierOutput = {
      verifier: {
        status: passed ? 'PASSED' : 'BLOCKED',
        total: 0,
        failed: 0,
        documents: [],
        note: 'No documents produced by the preceding stage to verify.',
      },
    }
    if (!passed) await blockNode(instance, node, output, actorId)
    return { passed, output }
  }

  const documents: VerifierDoc[] = []
  for (const doc of docs) {
    const verdict: Verdict = await runVerification(doc, userId, criteria)
    // Persist the verdict onto the consumable so the artifact catalog shows it too.
    const existing = await prisma.consumable.findUnique({ where: { id: doc.id }, select: { formData: true } }).catch(() => null)
    const formData = { ...((existing?.formData ?? {}) as Record<string, unknown>), _verification: verdict }
    await prisma.consumable.update({ where: { id: doc.id }, data: { formData: formData as Prisma.InputJsonValue } }).catch(() => undefined)
    documents.push({ id: doc.id, name: doc.name, passed: verdict.passed, findings: verdict.findings, rationale: verdict.rationale })
  }

  const failed = documents.filter(d => !d.passed).length
  const passed = failed === 0
  const output: VerifierOutput = {
    verifier: { status: passed ? 'PASSED' : 'BLOCKED', total: documents.length, failed, documents },
  }

  if (!passed) {
    await blockNode(instance, node, output, actorId)
  } else {
    await logEvent('VerifierPassed', 'WorkflowNode', node.id, actorId, { instanceId: instance.id, output })
    await publishOutbox('WorkflowNode', node.id, 'VerifierPassed', { instanceId: instance.id, nodeId: node.id, output })
  }
  return { passed, output }
}
