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
import { config } from '../../config'
import { assertInstancePermission } from '../../lib/permissions/workflowTemplate'
import { fetchEventsForInstance, rollupFromEvents, type AuditEvent } from '../../lib/audit-gov/client'

export const insightsRouter: Router = Router()

type StreamEvent = {
  id: string
  trace_id?: string | null
  kind?: string
  timestamp?: string
  payload?: unknown
}

function sseWrite(res: Response, event: string, data: unknown, id?: string) {
  if (id) res.write(`id: ${id}\n`)
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

async function traceIdsForInstance(instanceId: string): Promise<string[]> {
  const runs = await prisma.agentRun.findMany({
    where: { instanceId },
    select: {
      outputs: {
        where: { outputType: { in: ['EXECUTION_TRACE', 'LLM_RESPONSE', 'APPROVAL_REQUIRED'] } },
        select: { structuredPayload: true },
      },
    },
  })
  const ids = new Set<string>()
  for (const run of runs) {
    for (const out of run.outputs) {
      const payload = out.structuredPayload as Record<string, unknown> | null
      const trace = payload?.traceId
      if (typeof trace === 'string' && trace.length > 0) ids.add(trace)
    }
  }
  return Array.from(ids)
}

insightsRouter.get('/:id/events/stream', async (req: Request, res: Response, next) => {
  try {
    const instanceId = String(req.params.id)
    const instance = await prisma.workflowInstance.findUnique({
      where: { id: instanceId },
      select: { id: true, templateId: true },
    })
    if (!instance) return res.status(404).json({ code: 'NOT_FOUND', message: 'Workflow instance not found' })
    await assertInstancePermission(req.user!.userId, instance.id, 'view')

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')

    const seen = new Set(String(req.query.since_id ?? '').split(',').filter(Boolean))
    const started = Date.now()
    const maxMs = Math.min(Number(req.query.max_ms ?? 120_000), 10 * 60_000)
    const intervalMs = Math.max(Number(req.query.poll_ms ?? 800), 250)
    let closed = false
    req.on('close', () => { closed = true })

    while (!closed && Date.now() - started < maxMs) {
      const traceIds = await traceIdsForInstance(instance.id)
      for (const traceId of traceIds) {
        const url = new URL('/execute/events', config.CONTEXT_FABRIC_URL)
        url.searchParams.set('trace_id', traceId)
        url.searchParams.set('limit', '200')
        const cf = await fetch(url, {
          headers: config.CONTEXT_FABRIC_SERVICE_TOKEN
            ? { 'X-Service-Token': config.CONTEXT_FABRIC_SERVICE_TOKEN }
            : undefined,
        }).catch(() => null)
        if (!cf?.ok) continue
        const body = await cf.json().catch(() => ({})) as { events?: StreamEvent[] }
        for (const ev of body.events ?? []) {
          if (!ev.id || seen.has(ev.id)) continue
          seen.add(ev.id)
          sseWrite(res, ev.kind ?? 'event', ev, ev.id)
        }
      }
      res.write(': heartbeat\n\n')
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    sseWrite(res, 'done', { reason: closed ? 'client_closed' : 'timeout' })
    res.end()
  } catch (err) {
    next(err)
  }
})

interface NodeInsight {
  id: string
  label: string
  nodeType: string
  status: string
  positionX: number
  positionY: number
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  // True duration when startedAt + completedAt are written (M24.5+); else
  // null for non-terminal nodes; falls back to updatedAt - createdAt for
  // older runs that pre-date the timing columns.
  durationMs: number | null
  // True when the duration came from authoritative startedAt/completedAt.
  durationPrecise: boolean
  documents: Array<{ id: string; name: string; kind: string; sizeBytes: number | null; mimeType: string | null; uploadedAt: string }>
  consumables: Array<{ id: string; name: string; status: string; currentVersion: number; updatedAt: string }>
  workspace: Array<{
    branch?: string
    commitSha?: string
    changedPaths: string[]
    astIndexStatus?: string
    astIndexedFiles?: number
    astIndexedSymbols?: number
  }>
  citations: Array<{
    citationKey: string
    sourceKind: string
    sourceId: string
    confidence: number | null
    excerpt: string
  }>
  receipts: Array<{
    agentRunId: string
    status: string
    cfCallId?: string
    promptAssemblyId?: string
    mcpInvocationId?: string
    modelAlias?: string
    modelSelectionReason?: string
    provider?: string
    model?: string
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    estimatedCost?: number
    tokensSaved?: number
    promptEstimatedInputTokens?: number
    budgetWarnings: string[]
    retrievalStats?: Record<string, unknown>
    finishReason?: string
    artifactIds: string[]
    toolInvocationIds: string[]
  }>
  // M26 — present when the AGENT_TASK ran on a connected user laptop. The
  // SPA renders "🖥 served by your laptop ({device_name})" on the Gantt step.
  // Populated from cf.invoke.via_laptop events emitted by context-fabric.
  laptopDevice?: {
    user_id:     string
    device_id:   string
    device_name?: string
  }
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
  missionControl: {
    liveEventCount: number
    llmStreamEvents: number
    toolEvents: number
    approvalWaits: number
    artifactEvents: number
    codeChangeEvents: number
    astEvents: number
    branchEvents: number
    commitEvents: number
    receiptsCount: number
    workspaceSteps: number
    citationCount: number
  }
}

function durationOf(node: {
  status: string; createdAt: Date; updatedAt: Date;
  startedAt: Date | null; completedAt: Date | null;
}): { durationMs: number | null; precise: boolean } {
  // Authoritative: startedAt + completedAt written by the runtime (M24.5+).
  if (node.startedAt && node.completedAt) {
    return { durationMs: Math.max(0, node.completedAt.getTime() - node.startedAt.getTime()), precise: true }
  }
  // No timing yet recorded — only emit a number when the node has reached a
  // terminal status, falling back to the historic createdAt → updatedAt
  // heuristic for runs that pre-date the timing columns.
  if (node.status === 'COMPLETED' || node.status === 'FAILED' || node.status === 'SKIPPED') {
    return { durationMs: Math.max(0, node.updatedAt.getTime() - node.createdAt.getTime()), precise: false }
  }
  return { durationMs: null, precise: false }
}

function runDuration(run: { startedAt: Date | null; completedAt: Date | null; createdAt: Date; updatedAt: Date }): number | null {
  if (run.startedAt && run.completedAt) return run.completedAt.getTime() - run.startedAt.getTime()
  if (run.completedAt) return run.completedAt.getTime() - run.createdAt.getTime()
  return null
}

async function fetchAssemblyCitations(promptAssemblyId: string): Promise<NodeInsight['citations']> {
  try {
    const url = `${config.PROMPT_COMPOSER_URL.replace(/\/$/, '')}/api/v1/prompt-assemblies/${encodeURIComponent(promptAssemblyId)}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) return []
    const body = await resp.json() as { data?: { evidenceRefs?: unknown } }
    const refs = body.data?.evidenceRefs
    if (!Array.isArray(refs)) return []
    return refs.slice(0, 12).map((raw) => {
      const r = raw as Record<string, unknown>
      return {
        citationKey: String(r.citation_key ?? ''),
        sourceKind: String(r.source_kind ?? ''),
        sourceId: String(r.source_id ?? ''),
        confidence: typeof r.confidence === 'number' ? r.confidence : null,
        excerpt: String(r.excerpt ?? r.content ?? '').slice(0, 500),
      }
    }).filter(c => c.citationKey || c.excerpt)
  } catch {
    return []
  }
}

insightsRouter.get('/:id/insights', async (req: Request, res: Response, next) => {
  try {
    const id = String(req.params.id)
    // Reuse the existing instance-permission helper so the dashboard is scoped
    // to capabilities the user can already see.
    await assertInstancePermission(req.user!.userId, id, 'view')

    const [instance, nodes, documents, consumables, agentRuns] = await Promise.all([
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
          startedAt: true, completedAt: true,
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
      prisma.agentRun.findMany({
        where: { instanceId: id },
        select: {
          id: true,
          nodeId: true,
          status: true,
          outputs: {
            where: { outputType: 'LLM_RESPONSE' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { structuredPayload: true },
          },
        },
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
    // M26 — pluck out cf.invoke.via_laptop events so each AGENT_TASK can be
    // labelled with the laptop device it ran on.
    const laptopByNodeId = new Map<string, NodeInsight['laptopDevice']>()
    for (const e of events) {
      const p = (e.payload && typeof e.payload === 'object'
        ? e.payload as Record<string, unknown>
        : {}) as Record<string, unknown>
      const nodeId = (p.nodeId ?? p.workflow_node_id) as string | undefined
      if (nodeId) eventsByNodeId.set(nodeId, (eventsByNodeId.get(nodeId) ?? 0) + 1)
      if (e.kind === 'cf.invoke.via_laptop') {
        const targetNode = (p.workflow_node_id ?? p.workflowNodeId ?? nodeId) as string | undefined
        if (targetNode) {
          laptopByNodeId.set(targetNode, {
            user_id:     String(p.user_id ?? ''),
            device_id:   String(p.device_id ?? ''),
            device_name: typeof p.device_name === 'string' ? p.device_name : undefined,
          })
        }
      }
    }

    const consumablesByNode = new Map<string, typeof consumables>()
    for (const c of consumables) {
      if (!c.nodeId) continue
      const arr = consumablesByNode.get(c.nodeId) ?? []
      arr.push(c)
      consumablesByNode.set(c.nodeId, arr)
    }

    const workspaceByNode = new Map<string, NodeInsight['workspace']>()
    const receiptsByNode = new Map<string, NodeInsight['receipts']>()
    const assemblyIdsByNode = new Map<string, string>()
    for (const r of agentRuns) {
      if (!r.nodeId) continue
      const payload = r.outputs[0]?.structuredPayload as Record<string, unknown> | null
      if (!payload) continue
      const promptAssemblyId = (payload.promptAssemblyId
        ?? (payload.correlation as Record<string, unknown> | undefined)?.promptAssemblyId) as string | undefined
      if (promptAssemblyId) assemblyIdsByNode.set(r.nodeId, promptAssemblyId)
      const modelUsage = payload.modelUsage as Record<string, unknown> | undefined
      const tokensUsed = payload.tokensUsed as Record<string, unknown> | undefined
      const metrics = payload.metrics as Record<string, unknown> | undefined
      const prompt = payload.prompt as Record<string, unknown> | undefined
      const promptEstimatedInputTokens =
        typeof payload.promptEstimatedInputTokens === 'number' ? payload.promptEstimatedInputTokens
        : typeof prompt?.estimatedInputTokens === 'number' ? prompt.estimatedInputTokens
        : undefined
      const budgetWarnings = Array.isArray(payload.budgetWarnings) ? payload.budgetWarnings.map(String)
        : Array.isArray(prompt?.budgetWarnings) ? prompt.budgetWarnings.map(String)
        : []
      const retrievalStats = (payload.retrievalStats && typeof payload.retrievalStats === 'object'
        ? payload.retrievalStats
        : prompt?.retrievalStats && typeof prompt.retrievalStats === 'object'
          ? prompt.retrievalStats
          : undefined) as Record<string, unknown> | undefined
      const receiptArr = receiptsByNode.get(r.nodeId) ?? []
      receiptArr.push({
        agentRunId: r.id,
        status: String(r.status),
        cfCallId: (payload.cfCallId ?? (payload.correlation as Record<string, unknown> | undefined)?.cfCallId) as string | undefined,
        promptAssemblyId,
        mcpInvocationId: (payload.mcpInvocationId ?? (payload.correlation as Record<string, unknown> | undefined)?.mcpInvocationId) as string | undefined,
        modelAlias: (payload.modelAlias ?? modelUsage?.modelAlias) as string | undefined,
        modelSelectionReason: payload.modelSelectionReason as string | undefined,
        provider: modelUsage?.provider as string | undefined,
        model: modelUsage?.model as string | undefined,
        inputTokens: typeof tokensUsed?.input === 'number' ? tokensUsed.input : undefined,
        outputTokens: typeof tokensUsed?.output === 'number' ? tokensUsed.output : undefined,
        totalTokens: typeof tokensUsed?.total === 'number' ? tokensUsed.total : undefined,
        estimatedCost: typeof modelUsage?.estimatedCost === 'number' ? modelUsage.estimatedCost : undefined,
        tokensSaved: typeof metrics?.tokensSaved === 'number' ? metrics.tokensSaved : undefined,
        promptEstimatedInputTokens,
        budgetWarnings,
        retrievalStats,
        finishReason: payload.finishReason as string | undefined,
        artifactIds: Array.isArray(payload.artifactIds) ? payload.artifactIds.map(String) : [],
        toolInvocationIds: Array.isArray(payload.toolInvocationIds) ? payload.toolInvocationIds.map(String) : [],
      })
      receiptsByNode.set(r.nodeId, receiptArr)
      const branch = (payload.workspaceBranch ?? (payload.workspace as Record<string, unknown> | undefined)?.workspaceBranch) as string | undefined
      const commitSha = (payload.workspaceCommitSha ?? (payload.workspace as Record<string, unknown> | undefined)?.workspaceCommitSha) as string | undefined
      const changedPaths = (payload.changedPaths ?? (payload.workspace as Record<string, unknown> | undefined)?.changedPaths) as unknown
      const astIndexStatus = (payload.astIndexStatus ?? (payload.workspace as Record<string, unknown> | undefined)?.astIndexStatus) as string | undefined
      const astIndexedFiles = (payload.astIndexedFiles ?? (payload.workspace as Record<string, unknown> | undefined)?.astIndexedFiles) as number | undefined
      const astIndexedSymbols = (payload.astIndexedSymbols ?? (payload.workspace as Record<string, unknown> | undefined)?.astIndexedSymbols) as number | undefined
      if (!branch && !commitSha && !astIndexStatus) continue
      const arr = workspaceByNode.get(r.nodeId) ?? []
      arr.push({
        branch,
        commitSha,
        changedPaths: Array.isArray(changedPaths) ? changedPaths.map(String) : [],
        astIndexStatus,
        astIndexedFiles: typeof astIndexedFiles === 'number' ? astIndexedFiles : undefined,
        astIndexedSymbols: typeof astIndexedSymbols === 'number' ? astIndexedSymbols : undefined,
      })
      workspaceByNode.set(r.nodeId, arr)
    }

    const citationsByNode = new Map<string, NodeInsight['citations']>()
    await Promise.all(Array.from(assemblyIdsByNode.entries()).map(async ([nodeId, assemblyId]) => {
      citationsByNode.set(nodeId, await fetchAssemblyCitations(assemblyId))
    }))

    const nodesByStatus: Record<string, number> = {}
    for (const n of nodes) nodesByStatus[n.status] = (nodesByStatus[n.status] ?? 0) + 1

    const nodeInsights: NodeInsight[] = nodes.map((n) => {
      const d = durationOf(n)
      return ({
      id: n.id,
      label: n.label,
      nodeType: String(n.nodeType),
      status: String(n.status),
      positionX: n.positionX,
      positionY: n.positionY,
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
      startedAt:   n.startedAt?.toISOString()   ?? null,
      completedAt: n.completedAt?.toISOString() ?? null,
      durationMs: d.durationMs,
      durationPrecise: d.precise,
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
      workspace: workspaceByNode.get(n.id) ?? [],
      citations: citationsByNode.get(n.id) ?? [],
      receipts: receiptsByNode.get(n.id) ?? [],
      laptopDevice: laptopByNodeId.get(n.id),
      eventCount: eventsByNodeId.get(n.id) ?? 0,
      })
    })

    const eventKinds = events.map(e => e.kind)
    const countKind = (predicate: (kind: string) => boolean) =>
      eventKinds.reduce((count, kind) => count + (predicate(kind) ? 1 : 0), 0)

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
      missionControl: {
        liveEventCount: events.length,
        llmStreamEvents: countKind(kind => kind === 'llm.stream.delta'),
        toolEvents: countKind(kind => kind.startsWith('tool.invocation')),
        approvalWaits: countKind(kind => kind === 'approval.wait.created'),
        artifactEvents: countKind(kind => kind.startsWith('artifact.')),
        codeChangeEvents: countKind(kind => kind === 'code_change.detected'),
        astEvents: countKind(kind => kind.startsWith('workspace.ast')),
        branchEvents: countKind(kind => kind.startsWith('workspace.branch')),
        commitEvents: countKind(kind => kind === 'git.commit.created'),
        receiptsCount: Array.from(receiptsByNode.values()).reduce((sum, arr) => sum + arr.length, 0),
        workspaceSteps: Array.from(workspaceByNode.values()).reduce((sum, arr) => sum + arr.length, 0),
        citationCount: Array.from(citationsByNode.values()).reduce((sum, arr) => sum + arr.length, 0),
      },
    }

    res.json(response)
  } catch (err) {
    next(err)
  }
})
