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
    contextPlan?: Record<string, unknown>
    contextPlanHash?: string
    requiredContextStatus?: Record<string, unknown>
    governanceMode?: string
    executionPosture?: string
    blockedReason?: string
    finishReason?: string
    artifactIds: string[]
    toolInvocationIds: string[]
  }>
  workItems: Array<{
    id: string
    title: string
    status: string
    priority: number
    dueAt: string | null
    targets: Array<{
      id: string
      targetCapabilityId: string
      status: string
      roleKey: string | null
      childWorkflowInstanceId: string | null
      output: unknown
    }>
    events: Array<{ id: string; eventType: string; targetId: string | null; createdAt: string }>
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

interface AuditStageReport {
  id: string
  type: 'workflow_node' | 'workbench_stage'
  label: string
  stageKey?: string
  nodeId?: string | null
  nodeType?: string
  status: string
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  durationPrecise: boolean
  attempts: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCost: number | null
  pricingStatus: 'PRICED' | 'UNPRICED' | 'MIXED'
  provider?: string
  model?: string
  modelAlias?: string
  cfCallIds: string[]
  promptAssemblyIds: string[]
  mcpInvocationIds: string[]
  artifactIds: string[]
  consumableIds: string[]
  documentIds: string[]
  approvalCount: number
  eventCount: number
  warnings: string[]
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
    workItemCount: number
  }
  auditReport: {
    generatedAt: string
    coverage: {
      workflowStages: number
      workbenchStages: number
      budgetEvents: number
      auditEvents: number
      approvalRequests: number
    }
    totals: {
      durationMs: number | null
      inputTokens: number
      outputTokens: number
      totalTokens: number
      estimatedCost: number | null
      unpricedCalls: number
      approvals: number
      artifacts: number
      documents: number
      consumables: number
    }
    stages: AuditStageReport[]
    ledger: Array<{
      id: string
      eventType: string
      nodeId: string | null
      stageKey?: string
      agentRunId: string | null
      cfCallId: string | null
      promptAssemblyId: string | null
      inputTokensDelta: number
      outputTokensDelta: number
      totalTokensDelta: number
      estimatedCostDelta: number | null
      pricingStatus: string
      provider?: string
      model?: string
      modelAlias?: string
      createdAt: string
    }>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))))
}

function payloadOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function metadataOf(event: { metadata?: unknown }): Record<string, unknown> {
  return payloadOf(event.metadata)
}

function stageKeyOfBudgetEvent(event: { metadata?: unknown }): string | undefined {
  const metadata = metadataOf(event)
  return str(metadata.stageKey) ?? str(metadata.stage_key)
}

function durationFromIso(startedAt?: string | null, completedAt?: string | null): number | null {
  if (!startedAt || !completedAt) return null
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.max(0, end - start)
}

function stageAttemptsFromMetadata(metadata: unknown): Array<Record<string, unknown>> {
  const raw = payloadOf(metadata).stageAttempts
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord)
}

function artifactStageKey(artifact: { stage?: unknown; payload?: unknown }): string | undefined {
  const payload = payloadOf(artifact.payload)
  return str(payload.stageKey) ?? str(payload.stage_key) ?? (typeof artifact.stage === 'string' ? artifact.stage.toLowerCase() : undefined)
}

function consumableIdFromPayload(payload: unknown): string | undefined {
  const row = payloadOf(payload)
  const direct = str(row.consumableId)
  if (direct) return direct
  const publish = payloadOf(row.consumablePublish)
  return str(publish.consumableId)
}

function sumBudgetEvents(events: Array<{
  inputTokensDelta: number
  outputTokensDelta: number
  totalTokensDelta: number
  estimatedCostDelta: number | null
  pricingStatus: string
}>) {
  const inputTokens = events.reduce((sum, event) => sum + event.inputTokensDelta, 0)
  const outputTokens = events.reduce((sum, event) => sum + event.outputTokensDelta, 0)
  const totalTokens = events.reduce((sum, event) => sum + event.totalTokensDelta, 0)
  const pricedEvents = events.filter(event => event.estimatedCostDelta != null)
  const estimatedCost = pricedEvents.length > 0
    ? pricedEvents.reduce((sum, event) => sum + (event.estimatedCostDelta ?? 0), 0)
    : null
  const hasUnpriced = events.some(event => event.pricingStatus === 'UNPRICED')
  const hasPriced = events.some(event => event.pricingStatus === 'PRICED' && event.estimatedCostDelta != null)
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCost,
    pricingStatus: hasPriced && hasUnpriced ? 'MIXED' as const : hasUnpriced ? 'UNPRICED' as const : 'PRICED' as const,
  }
}

insightsRouter.get('/:id/insights', async (req: Request, res: Response, next) => {
  try {
    const id = String(req.params.id)
    // Reuse the existing instance-permission helper so the dashboard is scoped
    // to capabilities the user can already see.
    await assertInstancePermission(req.user!.userId, id, 'view')

    const [instance, nodes, documents, consumables, agentRuns, budget, blueprintSessions, approvalRequests, workItems] = await Promise.all([
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
          startedAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
          outputs: {
            where: { outputType: 'LLM_RESPONSE' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { structuredPayload: true },
          },
        },
      }),
      prisma.workflowRunBudget.findUnique({
        where: { instanceId: id },
        include: { events: { orderBy: { createdAt: 'asc' } } },
      }),
      prisma.blueprintSession.findMany({
        where: { workflowInstanceId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          goal: true,
          status: true,
          workflowInstanceId: true,
          metadata: true,
          artifacts: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, stage: true, kind: true, title: true, payload: true, createdAt: true },
          },
        },
      }),
      prisma.approvalRequest.findMany({
        where: { instanceId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          nodeId: true,
          subjectType: true,
          subjectId: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          decisions: { select: { decision: true, decidedAt: true } },
        },
      }),
      prisma.workItem.findMany({
        where: { sourceWorkflowInstanceId: id },
        orderBy: { createdAt: 'asc' },
        include: {
          targets: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              targetCapabilityId: true,
              status: true,
              roleKey: true,
              childWorkflowInstanceId: true,
              output: true,
            },
          },
          events: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, eventType: true, targetId: true, createdAt: true },
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

    const workItemsByNode = new Map<string, NodeInsight['workItems']>()
    for (const item of workItems) {
      if (!item.sourceWorkflowNodeId) continue
      const arr = workItemsByNode.get(item.sourceWorkflowNodeId) ?? []
      arr.push({
        id: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
        dueAt: item.dueAt?.toISOString() ?? null,
        targets: item.targets.map(target => ({
          id: target.id,
          targetCapabilityId: target.targetCapabilityId,
          status: target.status,
          roleKey: target.roleKey,
          childWorkflowInstanceId: target.childWorkflowInstanceId,
          output: target.output,
        })),
        events: item.events.map(event => ({
          id: event.id,
          eventType: event.eventType,
          targetId: event.targetId,
          createdAt: event.createdAt.toISOString(),
        })),
      })
      workItemsByNode.set(item.sourceWorkflowNodeId, arr)
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
      const contextPlan = (payload.contextPlan && typeof payload.contextPlan === 'object'
        ? payload.contextPlan
        : prompt?.contextPlan && typeof prompt.contextPlan === 'object'
          ? prompt.contextPlan
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
        contextPlan,
        contextPlanHash: (payload.contextPlanHash ?? (payload.correlation as Record<string, unknown> | undefined)?.contextPlanHash) as string | undefined,
        requiredContextStatus: payload.requiredContextStatus as Record<string, unknown> | undefined,
        governanceMode: payload.governanceMode as string | undefined,
        executionPosture: payload.executionPosture as string | undefined,
        blockedReason: payload.blockedReason as string | undefined,
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
      workItems: workItemsByNode.get(n.id) ?? [],
      laptopDevice: laptopByNodeId.get(n.id),
      eventCount: eventsByNodeId.get(n.id) ?? 0,
      })
    })

    const budgetEvents = budget?.events ?? []
    const budgetEventsByNode = new Map<string, typeof budgetEvents>()
    const budgetEventsByStage = new Map<string, typeof budgetEvents>()
    for (const event of budgetEvents) {
      if (event.nodeId) {
        const arr = budgetEventsByNode.get(event.nodeId) ?? []
        arr.push(event)
        budgetEventsByNode.set(event.nodeId, arr)
      }
      const stageKey = stageKeyOfBudgetEvent(event)
      if (stageKey) {
        const arr = budgetEventsByStage.get(stageKey) ?? []
        arr.push(event)
        budgetEventsByStage.set(stageKey, arr)
      }
    }

    const approvalsByNode = new Map<string, typeof approvalRequests>()
    for (const request of approvalRequests) {
      if (!request.nodeId) continue
      const arr = approvalsByNode.get(request.nodeId) ?? []
      arr.push(request)
      approvalsByNode.set(request.nodeId, arr)
    }

    const auditEventsByStage = new Map<string, number>()
    for (const event of events) {
      const stageKey = str(payloadOf(event.payload).stageKey) ?? str(payloadOf(event.payload).stage_key)
      if (stageKey) auditEventsByStage.set(stageKey, (auditEventsByStage.get(stageKey) ?? 0) + 1)
    }

    const workflowAuditStages: AuditStageReport[] = nodeInsights.map((node) => {
      const nodeBudgetEvents = budgetEventsByNode.get(node.id) ?? []
      const budgetTotals = sumBudgetEvents(nodeBudgetEvents)
      const receiptInput = node.receipts.reduce((sum, receipt) => sum + (receipt.inputTokens ?? 0), 0)
      const receiptOutput = node.receipts.reduce((sum, receipt) => sum + (receipt.outputTokens ?? 0), 0)
      const receiptTotal = node.receipts.reduce((sum, receipt) => sum + (receipt.totalTokens ?? 0), 0)
      const receiptCostValues = node.receipts.map(receipt => receipt.estimatedCost).filter((value): value is number => typeof value === 'number')
      const receiptCost = receiptCostValues.length > 0 ? receiptCostValues.reduce((sum, value) => sum + value, 0) : null
      const firstBudgetMetadata = nodeBudgetEvents.map(metadataOf).find(meta => str(meta.provider) || str(meta.model) || str(meta.modelAlias))
      const warnings = uniqueStrings([
        ...node.receipts.flatMap(receipt => receipt.budgetWarnings),
        budgetTotals.pricingStatus === 'UNPRICED' || budgetTotals.pricingStatus === 'MIXED' ? 'At least one usage record has no estimated cost.' : undefined,
        node.receipts.some(receipt => receipt.blockedReason) ? 'One or more model calls were blocked or degraded.' : undefined,
      ])
      return {
        id: node.id,
        type: 'workflow_node' as const,
        label: node.label,
        nodeId: node.id,
        nodeType: node.nodeType,
        status: node.status,
        startedAt: node.startedAt,
        completedAt: node.completedAt,
        durationMs: node.durationMs,
        durationPrecise: node.durationPrecise,
        attempts: Math.max(1, node.receipts.length),
        inputTokens: budgetTotals.inputTokens || receiptInput,
        outputTokens: budgetTotals.outputTokens || receiptOutput,
        totalTokens: budgetTotals.totalTokens || receiptTotal,
        estimatedCost: budgetTotals.estimatedCost ?? receiptCost,
        pricingStatus: budgetTotals.pricingStatus,
        provider: str(firstBudgetMetadata?.provider) ?? node.receipts.find(receipt => receipt.provider)?.provider,
        model: str(firstBudgetMetadata?.model) ?? node.receipts.find(receipt => receipt.model)?.model,
        modelAlias: str(firstBudgetMetadata?.modelAlias) ?? node.receipts.find(receipt => receipt.modelAlias)?.modelAlias,
        cfCallIds: uniqueStrings([...node.receipts.map(receipt => receipt.cfCallId), ...nodeBudgetEvents.map(event => event.cfCallId)]),
        promptAssemblyIds: uniqueStrings([...node.receipts.map(receipt => receipt.promptAssemblyId), ...nodeBudgetEvents.map(event => event.promptAssemblyId)]),
        mcpInvocationIds: uniqueStrings(node.receipts.map(receipt => receipt.mcpInvocationId)),
        artifactIds: uniqueStrings(node.receipts.flatMap(receipt => receipt.artifactIds)),
        consumableIds: node.consumables.map(consumable => consumable.id),
        documentIds: node.documents.map(document => document.id),
        approvalCount: approvalsByNode.get(node.id)?.length ?? 0,
        eventCount: node.eventCount,
        warnings,
      }
    })

    const workbenchAuditStages: AuditStageReport[] = []
    for (const session of blueprintSessions) {
      const metadata = payloadOf(session.metadata)
      const workflowNodeId = str(metadata.workflowNodeId)
      const attempts = stageAttemptsFromMetadata(session.metadata)
      for (const attempt of attempts) {
        const stageKey = str(attempt.stageKey) ?? 'stage'
        const stageArtifacts = session.artifacts.filter(artifact => artifactStageKey(artifact) === stageKey)
        const stageBudgetEvents = (budgetEventsByStage.get(stageKey) ?? []).filter(event =>
          !workflowNodeId || !event.nodeId || event.nodeId === workflowNodeId,
        )
        const budgetTotals = sumBudgetEvents(stageBudgetEvents)
        const tokensUsed = payloadOf(attempt.tokensUsed)
        const correlation = payloadOf(attempt.correlation)
        const inputTokens = budgetTotals.inputTokens || num(tokensUsed.input) || 0
        const outputTokens = budgetTotals.outputTokens || num(tokensUsed.output) || 0
        const totalTokens = budgetTotals.totalTokens || num(tokensUsed.total) || inputTokens + outputTokens
        const firstBudgetMetadata = stageBudgetEvents.map(metadataOf).find(meta => str(meta.provider) || str(meta.model) || str(meta.modelAlias))
        const startedAt = str(attempt.startedAt) ?? null
        const completedAt = str(attempt.completedAt) ?? null
        const verdict = str(attempt.verdict)
        const status = verdict ?? str(attempt.status) ?? String(session.status)
        const warnings = uniqueStrings([
          budgetTotals.pricingStatus === 'UNPRICED' || budgetTotals.pricingStatus === 'MIXED' ? 'At least one usage record has no estimated cost.' : undefined,
          str(attempt.error),
        ])
        workbenchAuditStages.push({
          id: str(attempt.id) ?? `${session.id}:${stageKey}`,
          type: 'workbench_stage',
          label: str(attempt.stageLabel) ?? stageKey,
          stageKey,
          nodeId: workflowNodeId ?? null,
          nodeType: 'WORKBENCH_STAGE',
          status,
          startedAt,
          completedAt,
          durationMs: durationFromIso(startedAt, completedAt),
          durationPrecise: Boolean(startedAt && completedAt),
          attempts: num(attempt.attemptNumber) ?? 1,
          inputTokens,
          outputTokens,
          totalTokens,
          estimatedCost: budgetTotals.estimatedCost,
          pricingStatus: budgetTotals.pricingStatus,
          provider: str(firstBudgetMetadata?.provider),
          model: str(firstBudgetMetadata?.model),
          modelAlias: str(firstBudgetMetadata?.modelAlias),
          cfCallIds: uniqueStrings([str(correlation.cfCallId), ...stageBudgetEvents.map(event => event.cfCallId)]),
          promptAssemblyIds: uniqueStrings([str(correlation.promptAssemblyId), ...stageBudgetEvents.map(event => event.promptAssemblyId)]),
          mcpInvocationIds: uniqueStrings([str(correlation.mcpInvocationId)]),
          artifactIds: uniqueStrings([
            ...(Array.isArray(attempt.artifactIds) ? attempt.artifactIds.map(String) : []),
            ...stageArtifacts.map(artifact => artifact.id),
          ]),
          consumableIds: uniqueStrings(stageArtifacts.map(artifact => consumableIdFromPayload(artifact.payload))),
          documentIds: [],
          approvalCount: verdict ? 1 : 0,
          eventCount: auditEventsByStage.get(stageKey) ?? 0,
          warnings,
        })
      }
    }

    const auditStages = [...workflowAuditStages, ...workbenchAuditStages]
      .sort((a, b) => Date.parse(a.startedAt ?? '') - Date.parse(b.startedAt ?? ''))
    const auditEstimatedCosts = auditStages.map(stage => stage.estimatedCost).filter((value): value is number => typeof value === 'number')
    const auditReport = {
      generatedAt: new Date().toISOString(),
      coverage: {
        workflowStages: workflowAuditStages.length,
        workbenchStages: workbenchAuditStages.length,
        budgetEvents: budgetEvents.length,
        auditEvents: events.length,
        approvalRequests: approvalRequests.length,
      },
      totals: {
        durationMs: runDuration(instance),
        inputTokens: auditStages.reduce((sum, stage) => sum + stage.inputTokens, 0),
        outputTokens: auditStages.reduce((sum, stage) => sum + stage.outputTokens, 0),
        totalTokens: auditStages.reduce((sum, stage) => sum + stage.totalTokens, 0),
        estimatedCost: auditEstimatedCosts.length > 0 ? auditEstimatedCosts.reduce((sum, value) => sum + value, 0) : null,
        unpricedCalls: auditStages.filter(stage => stage.pricingStatus === 'UNPRICED' || stage.pricingStatus === 'MIXED').length,
        approvals: approvalRequests.length + workbenchAuditStages.filter(stage => stage.approvalCount > 0).length,
        artifacts: uniqueStrings(auditStages.flatMap(stage => stage.artifactIds)).length,
        documents: documents.length,
        consumables: consumables.length,
      },
      stages: auditStages,
      ledger: budgetEvents.map(event => {
        const metadata = metadataOf(event)
        return {
          id: event.id,
          eventType: String(event.eventType),
          nodeId: event.nodeId,
          stageKey: stageKeyOfBudgetEvent(event),
          agentRunId: event.agentRunId,
          cfCallId: event.cfCallId,
          promptAssemblyId: event.promptAssemblyId,
          inputTokensDelta: event.inputTokensDelta,
          outputTokensDelta: event.outputTokensDelta,
          totalTokensDelta: event.totalTokensDelta,
          estimatedCostDelta: event.estimatedCostDelta,
          pricingStatus: event.pricingStatus,
          provider: str(metadata.provider),
          model: str(metadata.model),
          modelAlias: str(metadata.modelAlias),
          createdAt: event.createdAt.toISOString(),
        }
      }),
    }

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
        workItemCount: workItems.length,
      },
      auditReport,
    }

    res.json(response)
  } catch (err) {
    next(err)
  }
})
