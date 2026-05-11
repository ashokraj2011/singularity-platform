/**
 * M24 — run insights composite endpoint.
 *
 *   GET /api/workflow-instances/:id/insights
 *
 * Folds a single run together with: per-step durations (inferred from
 * createdAt → updatedAt), linked documents + consumables, and a cost /
 * token / governance rollup splotched in from audit-governance-service.
 *
 * Per-node durations are approximate: workgraph's WorkflowNode model has
 * no startedAt/completedAt columns yet, so we use `updatedAt - createdAt`
 * for COMPLETED nodes and "running" for everything else.
 */
import { Router, type Request, type Response } from 'express'
import { prisma } from '../../lib/prisma'
import { assertInstancePermission } from '../../lib/permissions/workflowTemplate'
import { fetchEventsForInstance, rollupFromEvents, type AuditEvent } from '../../lib/audit-gov/client'

export const insightsRouter: Router = Router()

interface NodeInsight {
  id: string
  label: string
  nodeType: string
  status: string
  positionX: number
  positionY: number
  createdAt: string
  updatedAt: string
  durationMs: number | null   // null for non-COMPLETED
  documents: Array<{ id: string; name: string; kind: string; sizeBytes: number | null; mimeType: string | null; uploadedAt: string }>
  consumables: Array<{ id: string; name: string; status: string; currentVersion: number; updatedAt: string }>
  // M22 emits agent.template.* + tool.execution.* + cf.execute.completed
  // etc. with subject_id = a sub-resource (not the node). We hand the SPA
  // the raw event count keyed to a node label when the payload has nodeId
  // — useful for "this AGENT_TASK fired 3 llm.call.completed events".
  eventCount: number
}

interface InsightsResponse {
  run: {
    id: string
    name: string
    status: string
    templateId: string | null
    startedAt: string | null
    completedAt: string | null
    createdAt: string
    updatedAt: string
    durationMs: number | null
  }
  totals: {
    nodes: number
    nodesByStatus: Record<string, number>
    documentsCount: number
    consumablesCount: number
    llm_calls: number
    total_tokens: number
    total_cost_usd: number
    governance_denied: number
  }
  nodes: NodeInsight[]
  documents: Array<{
    id: string; name: string; kind: string; mimeType: string | null; sizeBytes: number | null;
    nodeId: string | null; taskId: string | null; uploadedAt: string
  }>
  consumables: Array<{
    id: string; name: string; status: string; currentVersion: number;
    nodeId: string | null; updatedAt: string
  }>
  costByModel: Array<{ provider: string; model: string; calls: number; total_tokens: number; cost_usd: number }>
  events: Array<{
    id: string; source_service: string; kind: string; severity: string;
    subject_type: string | null; subject_id: string | null;
    created_at: string; payload: Record<string, unknown> | null
  }>
}

function durationOf(node: { status: string; createdAt: Date; updatedAt: Date }): number | null {
  if (node.status !== 'COMPLETED') return null
  return Math.max(0, node.updatedAt.getTime() - node.createdAt.getTime())
}

function runDuration(run: { startedAt: Date | null; completedAt: Date | null; createdAt: Date; updatedAt: Date }): number | null {
  if (run.startedAt && run.completedAt) return run.completedAt.getTime() - run.startedAt.getTime()
  if (run.completedAt) return run.completedAt.getTime() - run.createdAt.getTime()
  return null
}

insightsRouter.get('/:id/insights', async (req: Request, res: Response, next) => {
  try {
    const id = String(req.params.id)
    // Reuse the existing instance-permission helper so the dashboard is scoped
    // to capabilities the user can already see.
    await assertInstancePermission(req.user!.userId, id, 'view')

    const [instance, nodes, documents, consumables] = await Promise.all([
      prisma.workflowInstance.findUnique({
        where: { id },
        select: {
          id: true, name: true, status: true, templateId: true,
          startedAt: true, completedAt: true, createdAt: true, updatedAt: true,
        },
      }),
      prisma.workflowNode.findMany({
        where: { instanceId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, label: true, nodeType: true, status: true,
          positionX: true, positionY: true,
          createdAt: true, updatedAt: true,
          documents: {
            select: { id: true, name: true, kind: true, sizeBytes: true, mimeType: true, uploadedAt: true },
            orderBy: { uploadedAt: 'asc' },
          },
        },
      }),
      prisma.document.findMany({
        where: { instanceId: id },
        orderBy: { uploadedAt: 'asc' },
        select: { id: true, name: true, kind: true, mimeType: true, sizeBytes: true, nodeId: true, taskId: true, uploadedAt: true },
      }),
      prisma.consumable.findMany({
        where: { instanceId: id },
        orderBy: { updatedAt: 'asc' },
        select: { id: true, name: true, status: true, currentVersion: true, nodeId: true, updatedAt: true },
      }),
    ])

    if (!instance) {
      res.status(404).json({ code: 'NOT_FOUND' })
      return
    }

    const events: AuditEvent[] = await fetchEventsForInstance(id, 500)
    const rollup = rollupFromEvents(events)

    // Bucket events by node-id payload hint (workgraph publishOutbox doesn't
    // include nodeId today, but cf/mcp events sometimes do via correlation).
    const eventsByNodeId = new Map<string, number>()
    for (const e of events) {
      const nodeId = (e.payload && typeof e.payload === 'object'
        ? (e.payload as Record<string, unknown>).nodeId ?? (e.payload as Record<string, unknown>).workflow_node_id
        : undefined) as string | undefined
      if (nodeId) eventsByNodeId.set(nodeId, (eventsByNodeId.get(nodeId) ?? 0) + 1)
    }

    const consumablesByNode = new Map<string, typeof consumables>()
    for (const c of consumables) {
      if (!c.nodeId) continue
      const arr = consumablesByNode.get(c.nodeId) ?? []
      arr.push(c)
      consumablesByNode.set(c.nodeId, arr)
    }

    const nodesByStatus: Record<string, number> = {}
    for (const n of nodes) nodesByStatus[n.status] = (nodesByStatus[n.status] ?? 0) + 1

    const nodeInsights: NodeInsight[] = nodes.map((n) => ({
      id: n.id,
      label: n.label,
      nodeType: String(n.nodeType),
      status: String(n.status),
      positionX: n.positionX,
      positionY: n.positionY,
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
      durationMs: durationOf(n),
      documents: n.documents.map((d) => ({
        id: d.id, name: d.name, kind: d.kind,
        sizeBytes: d.sizeBytes == null ? null : Number(d.sizeBytes),
        mimeType: d.mimeType,
        uploadedAt: d.uploadedAt.toISOString(),
      })),
      consumables: (consumablesByNode.get(n.id) ?? []).map((c) => ({
        id: c.id, name: c.name, status: String(c.status),
        currentVersion: c.currentVersion, updatedAt: c.updatedAt.toISOString(),
      })),
      eventCount: eventsByNodeId.get(n.id) ?? 0,
    }))

    const response: InsightsResponse = {
      run: {
        id: instance.id,
        name: instance.name,
        status: String(instance.status),
        templateId: instance.templateId,
        startedAt:   instance.startedAt?.toISOString() ?? null,
        completedAt: instance.completedAt?.toISOString() ?? null,
        createdAt:   instance.createdAt.toISOString(),
        updatedAt:   instance.updatedAt.toISOString(),
        durationMs:  runDuration(instance),
      },
      totals: {
        nodes: nodes.length,
        nodesByStatus,
        documentsCount: documents.length,
        consumablesCount: consumables.length,
        llm_calls: rollup.llm_calls,
        total_tokens: rollup.total_tokens,
        total_cost_usd: rollup.total_cost_usd,
        governance_denied: rollup.governance_denied,
      },
      nodes: nodeInsights,
      documents: documents.map((d) => ({
        id: d.id, name: d.name, kind: d.kind,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes == null ? null : Number(d.sizeBytes),
        nodeId: d.nodeId, taskId: d.taskId,
        uploadedAt: d.uploadedAt.toISOString(),
      })),
      consumables: consumables.map((c) => ({
        id: c.id, name: c.name, status: String(c.status),
        currentVersion: c.currentVersion, nodeId: c.nodeId,
        updatedAt: c.updatedAt.toISOString(),
      })),
      costByModel: rollup.by_model,
      events: events.map((e) => ({
        id: e.id, source_service: e.source_service, kind: e.kind,
        severity: e.severity,
        subject_type: e.subject_type, subject_id: e.subject_id,
        created_at: e.created_at, payload: e.payload,
      })),
    }

    res.json(response)
  } catch (err) {
    next(err)
  }
})
