import { Prisma, type WorkflowNode, type WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import {
  contextFabricClient, type ExecuteRequest, ContextFabricError,
} from '../../../../lib/context-fabric/client'
import { config } from '../../../../config'
import { snapshotAgentTemplate, snapshotCapability } from '../../../../lib/snapshot'
import { prepareLlmBudget, recordWorkflowLlmUsage } from '../budget'

/**
 * AGENT_TASK node activation (M8).
 *
 * M5 wired this through prompt-composer; M8 inverts the orchestration so
 * context-fabric is the brain. AgentTaskExecutor now POSTs to
 * `context-fabric /execute`, which:
 *   1. Composes the prompt (calls prompt-composer in preview mode)
 *   2. Enriches with conversation history + summaries
 *   3. Resolves the per-capability MCP server (via IAM mcp_servers table)
 *   4. Discovers tools (via tool-service /tools/discover)
 *   5. Invokes the MCP /mcp/invoke loop
 *   6. Persists CallLog + memory + metrics
 *   7. Returns unified status + 7-level correlation chain
 *
 * `node.config` shape (all optional unless noted):
 *   {
 *     // Required for the M8 wire path:
 *     agentId:           string,        // workgraph Agent FK (existing)
 *     agentTemplateId:   string,        // composer/agent-and-tools UUID
 *     capabilityId:      string,        // IAM capability uuid (REQUIRED for MCP routing)
 *     task:              string,        // task with {{instance.vars.x}} refs
 *
 *     // Optional:
 *     agentBindingId:    string,
 *     phaseId:           string,
 *     artifacts:         ComposeArtifact[],
 *     overrides:         { additionalLayers, systemPromptAppend, extraContext },
 *     modelOverrides:    { provider, model, temperature, maxOutputTokens },
 *     contextPolicy:     { optimizationMode, maxContextTokens, compareWithRaw },
 *     limits:            { maxSteps, timeoutSec },
 *     previewOnly:       boolean,
 *   }
 *
 * On context-fabric errors the AgentRun is FAILED with the error captured
 * in AgentRunOutput so workgraph still has an audit trail.
 */
export async function activateAgentTask(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const standard = isRecord(cfg.standard) ? cfg.standard : {}
  const configString = (...keys: string[]) => {
    for (const key of keys) {
      const direct = cfg[key]
      if (typeof direct === 'string' && direct.trim()) return direct.trim()
      const std = standard[key]
      if (typeof std === 'string' && std.trim()) return std.trim()
    }
    return undefined
  }
  const configNumber = (...keys: string[]) => {
    const value = configString(...keys)
    if (!value) return undefined
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const cfgAgentId       = configString('agentId')
  const cfgAgentTemplate = configString('agentTemplateId')

  // M10/M11.c — config can carry either the local snapshot id (legacy) OR
  // the upstream agent-and-tools template id. If only the template id is
  // given, resolve/snapshot the template (provenance-aware) first.
  let agentId: string | undefined = cfgAgentId
  if (!agentId && cfgAgentTemplate) {
    const r = await snapshotAgentTemplate(cfgAgentTemplate, instance.createdById ?? undefined)
    agentId = r.agentId
  }
  if (!agentId) return

  // M11.c — also snapshot the capability for audit-replay parity.
  // Best-effort: failures don't block the run.
  const cfgCapabilityId = configString('capabilityId')
  if (cfgCapabilityId) {
    void snapshotCapability(cfgCapabilityId, instance.createdById ?? undefined).catch(() => null)
  }

  // 1. Always create an AgentRun for audit.
  const run = await prisma.agentRun.create({
    data: {
      agentId,
      instanceId: instance.id,
      nodeId: node.id,
      status: 'RUNNING',
      startedAt: new Date(),
    },
  })

  await logEvent('AgentRunStarted', 'AgentRun', run.id, undefined, {
    nodeId: node.id,
    instanceId: instance.id,
  })
  await publishOutbox('AgentRun', run.id, 'AgentRunStarted', { runId: run.id })

  // 2. Validate the M8 wire prerequisites.
  const agentTemplateId = cfgAgentTemplate
  const capabilityId = configString('capabilityId')
  const task = configString('task')

  if (!agentTemplateId || !task || !capabilityId) {
    await failRun(
      run.id,
      'config-missing',
      `node.config requires agentTemplateId, capabilityId, and task ` +
        `(got agentTemplateId=${agentTemplateId ?? 'null'}, ` +
        `capabilityId=${capabilityId ?? 'null'}, ` +
        `task=${task ? '<present>' : 'null'})`,
    )
    return
  }

  // 3. Build the /execute payload from node.config + instance.context.
  // workgraph stores vars/globals on instance.context under `_vars`/`_globals`
  // (cloneDesignToRun convention). Fall back to unprefixed keys if present.
  const instanceCtx = (instance.context ?? {}) as Record<string, unknown>
  const vars = (instanceCtx._vars ?? instanceCtx.vars ?? {}) as Record<string, unknown>
  const globals = (instanceCtx._globals ?? instanceCtx.globals ?? {}) as Record<string, unknown>

  const traceId = `wf-${instance.id}-${node.id}-${run.id.slice(0, 8)}`
  await prisma.agentRunOutput.create({
    data: {
      runId: run.id,
      outputType: 'EXECUTION_TRACE',
      rawContent: traceId,
      structuredPayload: {
        traceId,
        nodeId: node.id,
        instanceId: instance.id,
        contextFabricUrl: config.CONTEXT_FABRIC_URL,
      },
    },
  })
  const workflowDefaultModelAlias = await resolveWorkflowDefaultModelAlias(instance.templateId)
  const nodeModelAlias = configString('modelAlias')
  const legacyModel = configString('model')
  const modelSelectionReason = nodeModelAlias && nodeModelAlias !== '__workflow_default__'
    ? 'node override'
    : workflowDefaultModelAlias
      ? 'workflow default'
      : legacyModel
        ? 'advanced provider/model override'
        : 'mcp fallback default'
  const modelOverrides = {
    maxOutputTokens: 1200,
    ...((cfg.modelOverrides as Record<string, unknown> | undefined) ?? {}),
    ...(workflowDefaultModelAlias ? { modelAlias: workflowDefaultModelAlias } : {}),
    ...(nodeModelAlias && nodeModelAlias !== '__workflow_default__' ? { modelAlias: nodeModelAlias } : {}),
    ...(legacyModel && !nodeModelAlias ? { model: legacyModel } : {}),
  }
  const standardMaxTokens = configNumber('maxTokens')
  if (standardMaxTokens) modelOverrides.maxOutputTokens = standardMaxTokens
  const contextPolicy = {
    optimizationMode: 'medium',
    maxContextTokens: 6000,
    compareWithRaw: false,
    knowledgeTopK: 5,
    memoryTopK: 3,
    codeTopK: 5,
    maxLayerChars: 2500,
    maxPromptChars: 24_000,
    ...((cfg.contextPolicy as Record<string, unknown> | undefined) ?? {}),
  }
  const limits = {
    maxSteps: 3,
    timeoutSec: 240,
    inputTokenBudget: 6000,
    outputTokenBudget: 1200,
    maxHistoryMessages: 6,
    maxToolResultChars: 8000,
    maxPromptChars: 24_000,
    ...((cfg.limits as Record<string, unknown> | undefined) ?? {}),
  }

  const budgetDecision = await prepareLlmBudget({
    instance,
    node,
    agentRunId: run.id,
    contextPolicy,
    limits,
    modelOverrides,
  })
  if (budgetDecision.action === 'BLOCKED') {
    await prisma.agentRunOutput.create({
      data: {
        runId: run.id,
        outputType: 'BUDGET_APPROVAL_REQUIRED',
        rawContent: budgetDecision.reason,
        structuredPayload: { reason: budgetDecision.reason },
      },
    })
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'PAUSED' },
    })
    await logEvent('AgentRunPaused', 'AgentRun', run.id, undefined, {
      reason: budgetDecision.reason,
      nodeId: node.id,
      instanceId: instance.id,
    })
    await publishOutbox('AgentRun', run.id, 'AgentRunPaused', {
      runId: run.id,
      reason: budgetDecision.reason,
    })
    return
  }
  if (budgetDecision.action === 'FAIL') {
    await failRun(run.id, 'workflow-budget-exhausted', budgetDecision.reason)
    return
  }

  const executeReq: ExecuteRequest = {
    trace_id: traceId,
    idempotency_key: run.id,
    run_context: {
      workflow_instance_id: instance.id,
      workflow_node_id: node.id,
      agent_run_id: run.id,
      capability_id: capabilityId,
      tenant_id: configString('tenantId'),
      agent_template_id: agentTemplateId,
      // M26 — the calling user's IAM sub. context-fabric uses this to route
      // /mcp/invoke to the user's laptop mcp-server via the WS bridge.
      user_id: run.initiatedById ?? undefined,
      trace_id: traceId,
      branch_base: configString('branchBase'),
      branch_name: configString('branchName'),
    },
    task,
    vars,
    globals,
    prior_outputs: await collectPriorOutputs(instance.id, node.id),
    artifacts: (cfg.artifacts as unknown[] | undefined) ?? [],
    overrides: (cfg.overrides as Record<string, unknown> | undefined) ?? {},
    model_overrides: budgetDecision.modelOverrides,
    context_policy: budgetDecision.contextPolicy,
    limits: budgetDecision.limits,
    preview_only: cfg.previewOnly === true,
    // M26 — node-level opt-in. When the design sets preferLaptop:true, cf
    // requires a connected laptop and fails fast with MCP_NOT_CONNECTED
    // otherwise. Default (undefined) lets cf auto-prefer when available.
    prefer_laptop: cfg.preferLaptop === true ? true
      : cfg.preferLaptop === false ? false
      : undefined,
  }

  // 4. Call context-fabric /execute.
  let result: Awaited<ReturnType<typeof contextFabricClient.execute>>
  try {
    result = await contextFabricClient.execute(executeReq)
  } catch (err) {
    if (err instanceof ContextFabricError) {
      // M26 — surface MCP_NOT_CONNECTED / MCP_LAPTOP_TIMEOUT as friendlier
      // operator-facing failures with a retry hint.
      const detail = err.detail as { code?: string; message?: string } | undefined
      if (detail?.code === 'MCP_NOT_CONNECTED') {
        await failRun(run.id, 'mcp-not-connected',
          `${detail.message ?? 'Your laptop mcp-server is not connected.'} Run \`singularity-mcp start\` and retry this node.`)
        return
      }
      if (detail?.code === 'MCP_LAPTOP_TIMEOUT') {
        await failRun(run.id, 'mcp-laptop-timeout',
          `${detail.message ?? 'The laptop mcp-server did not respond in time.'} Re-run the node, or check \`singularity-mcp status\`.`)
        return
      }
      await failRun(run.id, 'context-fabric-error',
        `context-fabric error (${err.status}): ${err.message}`)
      return
    }
    await failRun(run.id, 'context-fabric-error', (err as Error).message)
    return
  }

  // 5. Persist the response.
  const correlation: Record<string, unknown> = {
    cfCallId: result.correlation.cfCallId,
    traceId: result.correlation.traceId,
    sessionId: result.correlation.sessionId,
    promptAssemblyId: result.correlation.promptAssemblyId,
    mcpServerId: result.correlation.mcpServerId,
    mcpInvocationId: result.correlation.mcpInvocationId,
    modelAlias: result.correlation.modelAlias ?? result.modelUsage?.modelAlias,
    modelSelectionReason,
    llmCallIds: result.correlation.llmCallIds,
    toolInvocationIds: result.correlation.toolInvocationIds,
    artifactIds: result.correlation.artifactIds,
    finishReason: result.finishReason,
    stepsTaken: result.stepsTaken,
    tokensUsed: result.tokensUsed,
    modelUsage: result.modelUsage,
    metrics: result.metrics,
    workspace: result.workspace,
    workspaceBranch: result.correlation.workspaceBranch ?? result.workspace?.workspaceBranch,
    workspaceCommitSha: result.correlation.workspaceCommitSha ?? result.workspace?.workspaceCommitSha,
    changedPaths: result.correlation.changedPaths ?? result.workspace?.changedPaths,
    astIndexStatus: result.correlation.astIndexStatus ?? result.workspace?.astIndexStatus,
    astIndexedFiles: result.correlation.astIndexedFiles ?? result.workspace?.astIndexedFiles,
    astIndexedSymbols: result.correlation.astIndexedSymbols ?? result.workspace?.astIndexedSymbols,
    warnings: [...(result.warnings ?? []), ...budgetDecision.warnings],
    prompt: result.prompt,
    promptEstimatedInputTokens: result.prompt?.estimatedInputTokens,
    budgetWarnings: result.prompt?.budgetWarnings ?? [],
    retrievalStats: result.prompt?.retrievalStats ?? {},
    contextFabricUrl: config.CONTEXT_FABRIC_URL,
  }

  await prisma.agentRunOutput.create({
    data: {
      runId: run.id,
      outputType: 'LLM_RESPONSE',
      rawContent: result.finalResponse ?? '',
      structuredPayload: correlation as Prisma.InputJsonValue,
      tokenCount: result.tokensUsed?.total ?? result.tokensUsed?.input ?? null,
    },
  })
  const finalArtifactId = await createAgentOutputArtifact({
    instance,
    node,
    runId: run.id,
    content: result.finalResponse ?? '',
    payload: correlation,
  })
  if (finalArtifactId) {
    correlation.finalArtifactId = finalArtifactId
    const existingArtifactIds = Array.isArray(correlation.artifactIds)
      ? correlation.artifactIds.map(String)
      : []
    correlation.artifactIds = Array.from(new Set([...existingArtifactIds, finalArtifactId]))
    await prisma.agentRunOutput.updateMany({
      where: { runId: run.id, outputType: 'LLM_RESPONSE' },
      data: { structuredPayload: correlation as Prisma.InputJsonValue },
    })
  }

  try {
    await recordWorkflowLlmUsage(instance.id, {
      nodeId: node.id,
      agentRunId: run.id,
      cfCallId: result.correlation.cfCallId,
      promptAssemblyId: result.correlation.promptAssemblyId,
      inputTokens: result.tokensUsed?.input,
      outputTokens: result.tokensUsed?.output,
      totalTokens: result.tokensUsed?.total,
      estimatedCost: result.modelUsage?.estimatedCost,
      provider: result.modelUsage?.provider,
      model: result.modelUsage?.model,
      metadata: {
        modelAlias: result.modelUsage?.modelAlias ?? result.correlation.modelAlias,
        finishReason: result.finishReason,
        status: result.status,
        tokensSaved: result.usage?.tokensSaved,
      },
    })
  } catch (err) {
    await logEvent('WorkflowBudgetUsageRecordFailed', 'WorkflowInstance', instance.id, undefined, {
      nodeId: node.id,
      agentRunId: run.id,
      cfCallId: result.correlation.cfCallId,
      error: (err as Error).message,
    })
  }

  if (result.status === 'FAILED') {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', completedAt: new Date() },
    })
    await logEvent('AgentRunFailed', 'AgentRun', run.id, undefined, {
      cfCallId: result.correlation.cfCallId,
      finishReason: result.finishReason,
    })
    await publishOutbox('AgentRun', run.id, 'AgentRunFailed', {
      runId: run.id,
      cfCallId: result.correlation.cfCallId,
    })
    return
  }

  // M9.z — MCP paused on a requires_approval tool. Persist the
  // pendingApproval payload as an APPROVAL_REQUIRED output so an operator
  // can locate the continuation_token and call /agent-runs/:id/approve.
  // The run stays open (no completedAt) until /resume completes it.
  if (result.status === 'WAITING_APPROVAL') {
    const pending = (result as unknown as { pendingApproval?: unknown }).pendingApproval
    await prisma.agentRunOutput.create({
      data: {
        runId: run.id,
        outputType: 'APPROVAL_REQUIRED',
        rawContent: '',
        structuredPayload: {
          pendingApproval: pending ?? null,
          cfCallId: result.correlation.cfCallId,
          traceId: result.correlation.traceId,
          mcpInvocationId: result.correlation.mcpInvocationId,
        },
      },
    })
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'PAUSED' },
    })
    await logEvent('AgentRunPaused', 'AgentRun', run.id, undefined, {
      cfCallId: result.correlation.cfCallId,
      mcpInvocationId: result.correlation.mcpInvocationId,
      pendingApproval: pending ?? null,
    })
    await publishOutbox('AgentRun', run.id, 'AgentRunPaused', {
      runId: run.id,
      cfCallId: result.correlation.cfCallId,
      pendingApproval: pending ?? null,
    })
    return
  }

  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: 'AWAITING_REVIEW', completedAt: new Date() },
  })

  await logEvent('AgentRunCompleted', 'AgentRun', run.id, undefined, {
    cfCallId: result.correlation.cfCallId,
    promptAssemblyId: result.correlation.promptAssemblyId,
    mcpInvocationId: result.correlation.mcpInvocationId,
    tokensUsed: result.tokensUsed,
  })
  await publishOutbox('AgentRun', run.id, 'AgentRunCompleted', {
    runId: run.id,
    cfCallId: result.correlation.cfCallId,
    mcpInvocationId: result.correlation.mcpInvocationId,
  })
}

async function failRun(runId: string, code: string, message: string) {
  await prisma.agentRunOutput.create({
    data: {
      runId,
      outputType: 'ERROR',
      rawContent: message,
      structuredPayload: { errorCode: code },
    },
  })
  await prisma.agentRun.update({
    where: { id: runId },
    data: { status: 'FAILED', completedAt: new Date() },
  })
  await logEvent('AgentRunFailed', 'AgentRun', runId, undefined, { errorCode: code, message })
  await publishOutbox('AgentRun', runId, 'AgentRunFailed', { runId, errorCode: code })
}

/**
 * Build the {{node.priorOutputs.<key>}} bag for this run by collecting the
 * latest LLM_RESPONSE output from each prior AgentRun on this instance.
 * Keys are the prior nodes' nodeIds.
 */
async function collectPriorOutputs(
  instanceId: string,
  currentNodeId: string,
): Promise<Record<string, unknown>> {
  const priorRuns = await prisma.agentRun.findMany({
    where: {
      instanceId,
      nodeId: { not: currentNodeId },
      status: 'APPROVED',
    },
    include: {
      outputs: {
        where: { outputType: { in: ['LLM_RESPONSE', 'PROMPT_PREVIEW'] } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })
  const out: Record<string, unknown> = {}
  for (const r of priorRuns) {
    if (!r.nodeId) continue
    const latest = r.outputs[0]
    if (!latest) continue
    const structured = latest.structuredPayload as Record<string, unknown> | null
    out[r.nodeId] = {
      runId: r.id,
      responseSummary: summarizePriorOutput(latest.rawContent ?? ''),
      outputType: latest.outputType,
      tokenCount: latest.tokenCount,
      artifactIds: Array.isArray(structured?.artifactIds) ? structured?.artifactIds : undefined,
      finalArtifactId: typeof structured?.finalArtifactId === 'string' ? structured.finalArtifactId : undefined,
      correlation: structured ? {
        cfCallId: structured.cfCallId,
        traceId: structured.traceId,
        promptAssemblyId: structured.promptAssemblyId,
        mcpInvocationId: structured.mcpInvocationId,
        finishReason: structured.finishReason,
      } : null,
    }
  }
  return out
}

async function createAgentOutputArtifact(args: {
  instance: WorkflowInstance
  node: WorkflowNode
  runId: string
  content: string
  payload: Record<string, unknown>
}): Promise<string | undefined> {
  const content = args.content.trim()
  if (!content) return undefined

  const type = await prisma.consumableType.upsert({
    where: { name: 'AGENT_OUTPUT' },
    update: {},
    create: {
      name: 'AGENT_OUTPUT',
      description: 'Reviewable AGENT_TASK output with prompt, model, budget, and receipt lineage.',
      requiresApproval: true,
      allowVersioning: true,
      schemaDef: {},
    },
  })
  const name = `${args.node.label || args.node.id} output`
  const existing = await prisma.consumable.findFirst({
    where: {
      typeId: type.id,
      instanceId: args.instance.id,
      nodeId: args.node.id,
      name,
    },
    select: { id: true, currentVersion: true },
  })
  const payload = {
    artifactType: 'agent_output',
    approvalRequired: true,
    agentRunId: args.runId,
    nodeId: args.node.id,
    nodeLabel: args.node.label,
    content,
    receipt: {
      cfCallId: args.payload.cfCallId,
      traceId: args.payload.traceId,
      promptAssemblyId: args.payload.promptAssemblyId,
      mcpInvocationId: args.payload.mcpInvocationId,
      modelAlias: args.payload.modelAlias,
      modelSelectionReason: args.payload.modelSelectionReason,
      tokensUsed: args.payload.tokensUsed,
      modelUsage: args.payload.modelUsage,
      citationsAvailable: Boolean(args.payload.promptAssemblyId),
      budgetWarnings: args.payload.budgetWarnings,
      retrievalStats: args.payload.retrievalStats,
    },
  }
  if (existing) {
    const nextVersion = existing.currentVersion + 1
    await prisma.consumableVersion.create({
      data: {
        consumableId: existing.id,
        version: nextVersion,
        payload: payload as Prisma.InputJsonValue,
        createdById: args.instance.createdById ?? undefined,
      },
    })
    await prisma.consumable.update({
      where: { id: existing.id },
      data: {
        status: 'UNDER_REVIEW',
        currentVersion: nextVersion,
        formData: payload as Prisma.InputJsonValue,
      },
    })
    await logEvent('AgentOutputArtifactVersioned', 'Consumable', existing.id, args.instance.createdById ?? undefined, {
      runId: args.runId,
      nodeId: args.node.id,
      version: nextVersion,
    })
    await publishOutbox('Consumable', existing.id, 'AgentOutputArtifactVersioned', {
      consumableId: existing.id,
      runId: args.runId,
      nodeId: args.node.id,
    })
    return existing.id
  }

  const created = await prisma.consumable.create({
    data: {
      typeId: type.id,
      instanceId: args.instance.id,
      nodeId: args.node.id,
      name,
      status: 'UNDER_REVIEW',
      currentVersion: 1,
      formData: payload as Prisma.InputJsonValue,
      createdById: args.instance.createdById ?? undefined,
      versions: {
        create: {
          version: 1,
          payload: payload as Prisma.InputJsonValue,
          createdById: args.instance.createdById ?? undefined,
        },
      },
    },
  })
  await logEvent('AgentOutputArtifactCreated', 'Consumable', created.id, args.instance.createdById ?? undefined, {
    runId: args.runId,
    nodeId: args.node.id,
  })
  await publishOutbox('Consumable', created.id, 'AgentOutputArtifactCreated', {
    consumableId: created.id,
    runId: args.runId,
    nodeId: args.node.id,
  })
  return created.id
}

function summarizePriorOutput(raw: string): string {
  const compact = raw
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter((line, index, lines) => line.trim() || lines[index - 1]?.trim())
    .join('\n')
    .trim()
  if (compact.length <= 1200) return compact
  return `${compact.slice(0, 1100).trimEnd()}\n...[prior output summarized; use artifact/correlation ids for full audit]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function resolveWorkflowDefaultModelAlias(templateId?: string | null): Promise<string | undefined> {
  if (!templateId) return undefined
  const workflow = await prisma.workflow.findUnique({
    where: { id: templateId },
    select: { budgetPolicy: true },
  })
  const policy = workflow?.budgetPolicy
  if (!isRecord(policy)) return undefined
  const value = policy.defaultModelAlias
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
