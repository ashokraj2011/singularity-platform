import { Prisma, type WorkflowNode, type WorkflowInstance } from '@prisma/client'
import { workflowNodeTraceId } from '@workgraph/shared-types'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
import { resolveCapabilityRepo } from '../../../../lib/agent-and-tools/capability-repo'
import { resolveLlmRouting } from '../../../llm-routing/resolve'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import {
  contextFabricClient, type ExecuteRequest, ContextFabricError,
} from '../../../../lib/context-fabric/client'
import { config } from '../../../../config'
import { agentRunCorrelationUpdate, mergeAgentRunCorrelation } from '../../../../lib/agent-run-correlation'
import { resolveRuntimeTenantId, runtimeTenantRequired } from '../../../../lib/runtime-tenant'
import { snapshotAgentTemplate, snapshotCapability } from '../../../../lib/snapshot'
import { enrichStageRequestWithGovernance } from '../../../governance/governance.service'
import { prepareLlmBudget, recordWorkflowLlmUsage } from '../budget'
import {
  executeReqToGovernedStageReq, governedStageRespToExecuteResp,
} from './governed-execute-adapter'

type GovernanceMode = NonNullable<ExecuteRequest['governance_mode']>

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
 *   5. Executes through Context Fabric's governed loop / tool dispatch
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
 *     modelOverrides:    { modelAlias, temperature, maxOutputTokens },
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
  // RLS/DB scoping only — distinct from the `tenantId` resolved below via
  // resolveRuntimeTenantId(), which is the business-logic tenant CF routes on.
  const dbTenantId = instance.tenantId ?? undefined
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
  const run = await withTenantDbTransaction(prisma, (tx) => tx.agentRun.create({
    data: {
      agentId,
      instanceId: instance.id,
      nodeId: node.id,
      attempt: node.attempt, // Finding #7 — record which node attempt this run belongs to.
      status: 'RUNNING',
      startedAt: new Date(),
    },
  }), dbTenantId)

  await logEvent('AgentRunStarted', 'AgentRun', run.id, undefined, {
    nodeId: node.id,
    instanceId: instance.id,
  })
  await publishOutbox('AgentRun', run.id, 'AgentRunStarted', { runId: run.id })

  // 2. Validate the M8 wire prerequisites.
  const agentTemplateId = cfgAgentTemplate
  // A workflow can be capability-INDEPENDENT: if the node doesn't pin a
  // capabilityId, use the work item's capability (parentCapabilityId — the same
  // source WorkbenchTaskExecutor reads). So one workflow runs for ANY
  // capability's work items and resolves THAT capability's repo. A node that DOES
  // set capabilityId stays tied to it.
  const _earlyCtx = (instance.context ?? {}) as Record<string, unknown>
  const _earlyVars = (_earlyCtx._vars ?? _earlyCtx.vars ?? {}) as Record<string, unknown>
  const workItemCapabilityId = typeof _earlyVars.parentCapabilityId === 'string' && _earlyVars.parentCapabilityId.trim()
    ? _earlyVars.parentCapabilityId.trim()
    : undefined
  const capabilityId = configString('capabilityId') ?? workItemCapabilityId
  // Laptop routing identity — the bridge registers devices by IAM user id (the
  // device JWT's sub), but run.initiatedById / instance.createdById are
  // workgraph-LOCAL user ids, so user-keyed routing silently never matched and
  // every dispatch fell back to the HTTP mcp URL. Resolve the launcher's
  // iamUserId; auto-advanced nodes (no initiator) inherit the instance creator.
  const launcherLocalId = run.initiatedById ?? instance.createdById ?? undefined
  let launcherIamId: string | undefined = launcherLocalId ?? undefined
  if (launcherLocalId) {
    const launcher = await prisma.user
      .findUnique({ where: { id: launcherLocalId }, select: { iamUserId: true } })
      .catch(() => null)
    if (launcher?.iamUserId) launcherIamId = launcher.iamUserId
  }
  const baseTask = configString('task')
  // Refine loop: the run-graph Chat "Send feedback" sets _refineFeedback on the
  // node + restarts it; append the note so the re-run addresses it (copilot prompt
  // or governed task alike).
  const refineFeedback = configString('_refineFeedback')
  // Clarifying-question answers: the run-graph Questions tab POSTs answers to
  // /answer-questions, which sets _copilotAnswers + restarts the node. Inject
  // them as decisions so the re-run uses the operator's choices, not guesses.
  const copilotAnswers = configString('_copilotAnswers')
  let task = baseTask
  if (task && refineFeedback) {
    task = `${task}\n\n## Reviewer feedback to address (refinement)\n${refineFeedback}`
  }
  if (task && copilotAnswers) {
    task = `${task}\n\n## Answers to your clarifying questions\n${copilotAnswers}\n` +
      `Treat these as confirmed decisions — apply them and do not ask them again.`
  }

  if (!agentTemplateId || !task || !capabilityId) {
    await failRun(
      run.id,
      'config-missing',
      `node.config requires agentTemplateId, capabilityId, and task ` +
        `(got agentTemplateId=${agentTemplateId ?? 'null'}, ` +
        `capabilityId=${capabilityId ?? 'null'}, ` +
        `task=${task ? '<present>' : 'null'})`,
      dbTenantId,
    )
    return
  }

  // 3. Build the /execute payload from node.config + instance.context.
  // workgraph stores vars/globals on instance.context under `_vars`/`_globals`
  // (cloneDesignToRun convention). Fall back to unprefixed keys if present.
  const instanceCtx = (instance.context ?? {}) as Record<string, unknown>
  const vars = (instanceCtx._vars ?? instanceCtx.vars ?? {}) as Record<string, unknown>
  const globals = (instanceCtx._globals ?? instanceCtx.globals ?? {}) as Record<string, unknown>
  const tenantId = resolveRuntimeTenantId({ nodeConfig: cfg, instanceContext: instanceCtx })
  if (runtimeTenantRequired(config.TENANT_ISOLATION_MODE) && !tenantId) {
    await failRun(
      run.id,
      'tenant-id-required',
      'TENANT_ISOLATION_MODE=strict requires a tenantId/tenant_id on the node config, workflow context, vars/globals, or WorkItem input before AGENT_TASK can call Context Fabric.',
      dbTenantId,
    )
    return
  }

  // §13.4 working-dir — resolve the repo a copilot node clones into its sandbox.
  // Precedence: work-item `repoUrl` var (per item) → the capability's LINKED repo
  // (agent-runtime) → node.config.sourceUri (workflow default). Without one,
  // Copilot runs in an empty dir.
  let copilotRepo: string | undefined
  if (configString('executor') === 'copilot') {
    const fromVar = typeof vars.repoUrl === 'string' && vars.repoUrl.trim() ? vars.repoUrl.trim() : undefined
    copilotRepo = fromVar
      ?? (capabilityId ? await resolveCapabilityRepo(capabilityId) : undefined)
      ?? configString('sourceUri')
  }

  const traceId = workflowNodeTraceId({
    workflowInstanceId: instance.id,
    workflowNodeId: node.id,
    runId: run.id,
  })
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
  await withTenantDbTransaction(prisma, (tx) => tx.agentRun.update({
    where: { id: run.id },
    data: { traceId },
  }), dbTenantId)
  const workflowDefaultModelAlias = await resolveWorkflowDefaultModelAlias(instance.templateId)
  const workflowDefaultGovernanceMode = await resolveWorkflowGovernanceMode(instance.templateId, node)
  const explicitGovernanceMode = configString('governanceMode')
  const governanceMode = isGovernanceMode(explicitGovernanceMode)
    ? explicitGovernanceMode
    : workflowDefaultGovernanceMode
  const nodeModelAlias = configString('modelAlias')
  const legacyModel = configString('model')
  // Runtime override: a per-run model chosen at launch, threaded via
  // context._globals.modelAlias. HIGHEST precedence — a launch-time pick wins
  // over node/workflow/routing so the operator can switch models per run without
  // editing the design. '__workflow_default__' means "don't override".
  const runtimeModelAlias = typeof globals.modelAlias === 'string' && globals.modelAlias.trim() && globals.modelAlias !== '__workflow_default__'
    ? globals.modelAlias.trim()
    : ''
  const modelSelectionReason = runtimeModelAlias
    ? 'runtime override (launch)'
    : nodeModelAlias && nodeModelAlias !== '__workflow_default__'
      ? 'node override'
      : workflowDefaultModelAlias
        ? 'workflow default'
        : legacyModel
          ? 'legacy alias'
          : 'gateway default alias'
  // LLM routing: the GOVERNED_AGENT touch point may be wired to a connection (per
  // capability / user / default) in the routing canvas. Applies only when neither
  // the node nor the workflow set an explicit alias. Precedence: node > workflow >
  // routing > legacy > gateway default.
  const _nodeAliasExplicit = !!nodeModelAlias && nodeModelAlias !== '__workflow_default__'
  // Copilot workflows route governed agents through the COPILOT_SDLC touch point
  // (Copilot gateway); everything else uses GOVERNED_AGENT. Routing only fills when
  // neither the node nor the workflow set an explicit alias.
  const workflowUsesCopilot = await resolveWorkflowUsesCopilot(instance.templateId)
  const routedTouchPoint = workflowUsesCopilot ? 'COPILOT_SDLC' : 'GOVERNED_AGENT'
  const routedModelAlias = (!_nodeAliasExplicit && !workflowDefaultModelAlias)
    ? await resolveLlmRouting(routedTouchPoint, { capabilityId, userId: instance.createdById })
    : null
  const modelOverrides: Record<string, unknown> = {
    maxOutputTokens: 1200,
    ...((cfg.modelOverrides as Record<string, unknown> | undefined) ?? {}),
    ...(workflowDefaultModelAlias ? { modelAlias: workflowDefaultModelAlias } : {}),
    ...(nodeModelAlias && nodeModelAlias !== '__workflow_default__' ? { modelAlias: nodeModelAlias } : {}),
    ...(routedModelAlias ? { modelAlias: routedModelAlias } : {}),
    ...(legacyModel && !nodeModelAlias && !workflowDefaultModelAlias && !routedModelAlias ? { modelAlias: legacyModel } : {}),
    // Highest precedence: per-run launch override (last spread wins).
    ...(runtimeModelAlias ? { modelAlias: runtimeModelAlias } : {}),
  }
  delete modelOverrides.provider
  delete modelOverrides.model
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
    await withTenantDbTransaction(prisma, (tx) => tx.agentRun.update({
      where: { id: run.id },
      data: { status: 'PAUSED' },
    }), dbTenantId)
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
    await failRun(run.id, 'workflow-budget-exhausted', budgetDecision.reason, dbTenantId)
    return
  }

  const instanceContext = isRecord(instance.context) ? instance.context : {}
  const workItemRef = isRecord(instanceContext._workItem) ? instanceContext._workItem : {}
  const realWorkItemId = typeof workItemRef.id === 'string' && workItemRef.id.trim()
    ? workItemRef.id.trim()
    : undefined
  const workCode = typeof workItemRef.workCode === 'string' && workItemRef.workCode.trim()
    ? workItemRef.workCode.trim()
    : undefined

  // Branch to clone for this run: a launch-time pick (globals.sourceRef, set by
  // the Start dialog) wins over a node-config ref. Passed to CF as run_context
  // source_ref; without it the materializer blindly defaults to `main`.
  const sourceRefChoice = (typeof globals.sourceRef === 'string' && globals.sourceRef.trim())
    ? globals.sourceRef.trim()
    : (configString('sourceRef') ?? undefined)

  const executeReq: ExecuteRequest = {
    trace_id: traceId,
    idempotency_key: run.id,
    run_context: {
      workflow_instance_id: instance.id,
      workflow_node_id: node.id,
      agent_run_id: run.id,
      work_item_id: realWorkItemId,
      work_item_code: workCode,
      capability_id: capabilityId,
      tenant_id: tenantId,
      agent_template_id: agentTemplateId,
      // M26 — the calling user's IAM sub (resolved from users.iamUserId; falls
      // back to the instance creator for auto-advanced nodes). context-fabric
      // routes laptop-bridge dispatch by this id — it must equal the device
      // JWT's sub or the bridge is silently skipped.
      user_id: launcherIamId,
      trace_id: traceId,
      branch_base: configString('branchBase'),
      branch_name: configString('branchName') ?? (workCode ? `work/${workCode}` : undefined),
      // §13.4 — when node.config.executor === 'copilot', CF dispatches the
      // copilot_execute tool to the laptop mcp-server instead of the LLM loop.
      // Both the flag and the task ride run_context because the governed-stage
      // route (where CF's copilot branch lives) has no top-level `task` and
      // receives run_context as a verbatim dict.
      executor: configString('executor'),
      ...(configString('executor') === 'copilot' ? { task } : {}),
      // Runtime prompt override (run-graph Prompt tab "Edit prompt") — CF uses this
      // VERBATIM and skips composition (compose_copilot_prompt returns it as-is).
      ...(configString('_promptOverride') ? { prompt_override: configString('_promptOverride') } : {}),
      // §13.4 working-dir: clone the resolved repo (work-item var → capability's
      // linked repo → node default) into the work-item sandbox so Copilot runs in
      // the TARGET repo. Resolved above as `copilotRepo`.
      ...(copilotRepo ? { source_type: configString('sourceType') ?? 'github', source_uri: copilotRepo, ...(sourceRefChoice ? { source_ref: sourceRefChoice } : {}) } : {}),
    },
    task,
    vars,
    globals,
    prior_outputs: await collectPriorOutputs(instance.id, node.id, dbTenantId),
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
    governance_mode: governanceMode,
  }

  // Architecture gap #1 / task #119 — governed migration.
  //
  // Compatibility opt-in paths also flip this node to /execute-governed-stage:
  //   - cfg.useGovernedExecutor === true on the node design (per-node)
  //   - config.CONTEXT_FABRIC_USE_GOVERNED_FOR_NON_BLUEPRINT === true (deployment-wide)
  //
  // By default, WORKGRAPH_FORCE_GOVERNED_CODING is on, so only explicit
  // per-node opt-out or incident-recovery env config reaches legacy /execute.
  // The adapter (governed-execute-adapter.ts) maps the legacy ExecuteRequest
  // into a GovernedStageRequest and the response back into the
  // ExecuteResponse shape the downstream persistence + correlation code
  // expects, so the rest of this executor stays unchanged regardless of
  // which path served the request.
  //
  // Phase: AgentTaskExecutor first. ContractReplay, EventHorizonChat, and
  // PromptComposerRespond migrate in follow-ups (each independently
  // flag-able once their callers grow the equivalent toggle).
  // M99 S3.1 — Phase-3 default flip. WORKGRAPH_FORCE_GOVERNED_CODING makes
  // governed the DEFAULT for non-blueprint coding nodes: governed runs unless
  // the node explicitly opts OUT (useGovernedExecutor === false). This is the
  // inverse polarity of the two task-#119 opt-IN paths below, so it's
  // evaluated first and an explicit per-node false still wins (operator escape
  // hatch).
  const forceGoverned = config.WORKGRAPH_FORCE_GOVERNED_CODING === true
    && cfg.useGovernedExecutor !== false
  const useGoverned = forceGoverned
    || cfg.useGovernedExecutor === true
    || config.CONTEXT_FABRIC_USE_GOVERNED_FOR_NON_BLUEPRINT === true
    // §13.4 — copilot-executor nodes always take the governed route: CF's
    // copilot branch lives in /execute-governed-stage and short-circuits the
    // loop there. (executor + task ride run_context for that route to read.)
    || configString('executor') === 'copilot'

  // 4. Call context-fabric — governed or legacy depending on the flag.
  let result: Awaited<ReturnType<typeof contextFabricClient.execute>>
  try {
    if (useGoverned) {
      // Map legacy → governed → call → map back. The adapter file owns
      // the field-by-field rules; this caller just orchestrates.
      const govReq = executeReqToGovernedStageReq(executeReq, {
        stageKey: typeof cfg.governedStageKey === 'string' ? cfg.governedStageKey : undefined,
        agentRole: typeof cfg.governedAgentRole === 'string' ? cfg.governedAgentRole : undefined,
        maxTurns: typeof cfg.governedMaxTurns === 'number' ? cfg.governedMaxTurns : undefined,
      })
      // Capability Governance Model (G5) — resolve + attach the governance overlay
      // + active waivers so CF's enforcement gate can block on unmet BLOCKING/
      // REQUIRED controls. Fail-open: no-op when there's no governance.
      await enrichStageRequestWithGovernance(govReq)
      const govResp = await contextFabricClient.executeGovernedStage(govReq)
      result = governedStageRespToExecuteResp(govResp, {
        traceId: executeReq.trace_id ?? null,
        governanceMode,
        // sessionId isn't a typed field on ExecuteRunContext today;
        // pull it from the loose dict-shape if the caller stashed one,
        // otherwise null. Audit-gov correlation still wires up via
        // cfCallId so this isn't on the critical path.
        sessionId: ((executeReq.run_context as unknown as Record<string, unknown>)?.session_id as string | null) ?? null,
      })
    } else {
      result = await contextFabricClient.execute(executeReq)
    }
  } catch (err) {
    if (err instanceof ContextFabricError) {
      // M26 — surface MCP_NOT_CONNECTED / MCP_LAPTOP_TIMEOUT as friendlier
      // operator-facing failures with a retry hint.
      const detail = err.detail as { code?: string; message?: string } | undefined
      if (detail?.code === 'MCP_NOT_CONNECTED') {
        await failRun(run.id, 'mcp-not-connected',
          `${detail.message ?? 'Your laptop mcp-server is not connected.'} Run \`singularity-mcp start\` and retry this node.`, dbTenantId)
        return
      }
      if (detail?.code === 'MCP_LAPTOP_TIMEOUT') {
        await failRun(run.id, 'mcp-laptop-timeout',
          `${detail.message ?? 'The laptop mcp-server did not respond in time.'} Re-run the node, or check \`singularity-mcp status\`.`, dbTenantId)
        return
      }
      // M28 governance-1 — fail_closed denial: audit-gov was unreachable so
      // cf refused to run un-governed work. Operator-actionable: either
      // restore audit-gov, or relax this node's governanceMode to fail_open.
      if (detail?.code === 'GOVERNANCE_UNAVAILABLE') {
        await failRun(run.id, 'governance-unavailable',
          `${detail.message ?? 'audit-governance is unreachable.'} This node has governanceMode=fail_closed; relax it or restore audit-gov and re-run.`, dbTenantId)
        return
      }
      if (detail?.code === 'CONTEXT_PLAN_INVALID') {
        const missing = (detail as { requiredContextStatus?: { missingRequired?: Array<{ layerType?: string }> } })
          .requiredContextStatus?.missingRequired?.map(m => m.layerType).filter(Boolean).join(', ')
        await failRun(run.id, 'context-plan-invalid',
          `${detail.message ?? 'Required prompt context is missing.'}${missing ? ` Missing: ${missing}.` : ''} Fix the prompt profile/layers or change governance mode and re-run.`, dbTenantId)
        return
      }
      await failRun(run.id, 'context-fabric-error',
        `context-fabric error (${err.status}): ${err.message}`, dbTenantId)
      return
    }
    await failRun(run.id, 'context-fabric-error', (err as Error).message, dbTenantId)
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
    contextPlanHash: result.contextPlanHash ?? result.correlation.contextPlanHash,
    requiredContextStatus: result.requiredContextStatus,
    governanceMode: result.governanceMode ?? result.correlation.governanceMode,
    executionPosture: result.executionPosture ?? result.correlation.executionPosture,
    blockedReason: result.blockedReason,
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
    contextPlan: result.prompt?.contextPlan,
    contextFabricUrl: config.CONTEXT_FABRIC_URL,
  }
  await withTenantDbTransaction(prisma, (tx) => tx.agentRun.update({
    where: { id: run.id },
    data: agentRunCorrelationUpdate(correlation),
  }), dbTenantId)

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

  // §13.4 — store each produced file (REQUIREMENTS.md, DESIGN.md…) as its own
  // per-phase artifact with the FULL content, so the UI shows the doc itself —
  // not just the agent summary. Keyed by name (the path) + node (= workId/phase).
  const producedFiles = (result.workspace as { artifacts?: Array<{ path: string; content: string }> } | null | undefined)?.artifacts ?? []
  for (const art of producedFiles.slice(0, 25)) {
    if (art?.path && art?.content?.trim()) {
      await createAgentOutputArtifact({
        instance, node, runId: run.id, content: art.content, name: art.path,
        payload: { artifactKind: 'produced_file', path: art.path },
      }).catch(() => undefined)
    }
  }

  // Copilot clarifying questions — parse the "## Questions" block Copilot was
  // asked to emit (copilot_executor.compose_copilot_prompt) out of its reply,
  // and store it as a dedicated consumable so the run-graph "Questions" tab can
  // render it and re-run the stage with the operator's answers. Copilot-only.
  if (configString('executor') === 'copilot') {
    const questions = parseCopilotQuestions(result.finalResponse ?? '')
    if (questions.length > 0) {
      await createAgentOutputArtifact({
        instance, node, runId: run.id, name: COPILOT_QUESTIONS_ARTIFACT,
        content: JSON.stringify(questions),
        payload: { artifactKind: 'copilot_questions' },
      }).catch(() => undefined)
    }
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
        promptCache: result.modelUsage?.promptCache ?? result.usage?.promptCache ?? result.promptCache ?? result.tokensUsed?.promptCache,
      },
    }, instance.tenantId ?? undefined)
  } catch (err) {
    await logEvent('WorkflowBudgetUsageRecordFailed', 'WorkflowInstance', instance.id, undefined, {
      nodeId: node.id,
      agentRunId: run.id,
      cfCallId: result.correlation.cfCallId,
      error: (err as Error).message,
    })
  }

  if (result.status === 'FAILED') {
    await withTenantDbTransaction(prisma, (tx) => tx.agentRun.update({
      where: { id: run.id },
      data: mergeAgentRunCorrelation({ status: 'FAILED', completedAt: new Date() }, correlation),
    }), dbTenantId)
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
          governanceMode: result.governanceMode ?? result.correlation.governanceMode,
          // Governed pause — persist the PhaseState + run_context so /approve can
          // rehydrate + resume via the governed path (legacy resume can't: the
          // cfCallId is synthetic). null for legacy tool pauses (continuation_token).
          governedFinalState: (result as unknown as { governedFinalState?: unknown }).governedFinalState ?? null,
          governedRunContext: (result as unknown as { governedFinalState?: unknown }).governedFinalState
            ? (executeReq.run_context as unknown as Record<string, unknown>)
            : null,
        } as unknown as Prisma.InputJsonValue,
      },
    })
    await withTenantDbTransaction(prisma, (tx) => tx.agentRun.update({
      where: { id: run.id },
      data: mergeAgentRunCorrelation({ status: 'PAUSED' }, {
        ...correlation,
        cfCallId: result.correlation.cfCallId,
        traceId: result.correlation.traceId,
        mcpInvocationId: result.correlation.mcpInvocationId,
      }),
    }), dbTenantId)
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

  await withTenantDbTransaction(prisma, (tx) => tx.agentRun.update({
    where: { id: run.id },
    data: mergeAgentRunCorrelation({ status: 'AWAITING_REVIEW', completedAt: new Date() }, correlation),
  }), dbTenantId)

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

async function failRun(runId: string, code: string, message: string, tenantId?: string) {
  await prisma.agentRunOutput.create({
    data: {
      runId,
      outputType: 'ERROR',
      rawContent: message,
      structuredPayload: { errorCode: code },
    },
  })
  await withTenantDbTransaction(prisma, (tx) => tx.agentRun.update({
    where: { id: runId },
    data: { status: 'FAILED', completedAt: new Date() },
  }), tenantId)
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
  tenantId?: string,
): Promise<Record<string, unknown>> {
  const priorRuns = await withTenantDbTransaction(prisma, (tx) => tx.agentRun.findMany({
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
  }), tenantId)
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

// Consumable name under which a node's parsed Copilot clarifying questions are
// stored (JSON in formData.content). The run-graph panel reads this back.
const COPILOT_QUESTIONS_ARTIFACT = '_copilot_questions'

type CopilotQuestion = { id: string; question: string; options?: string[] }

// Parse a "## Questions" (a.k.a. Open Questions / Clarifications) markdown block
// out of a Copilot reply into structured questions. Mirrors how the blueprint
// workbench parses LLM open-questions: heading scan → bullet split → inline
// `|`-delimited options.
function isCopilotQuestionsHeading(line: string): boolean {
  const t = line.trim()
  if (!t.startsWith('#') && !t.startsWith('**')) return false
  const h = t.replace(/^#+\s*/, '').replace(/^\*\*|\*\*$/g, '').replace(/[:：]\s*$/, '').trim().toLowerCase()
  return ['questions', 'open questions', 'clarification', 'clarifications', 'clarifying questions',
    'questions for user', 'questions for the user'].includes(h)
}
function parseCopilotQuestions(text: string): CopilotQuestion[] {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(isCopilotQuestionsHeading)
  if (start < 0) return []
  const out: CopilotQuestion[] = []
  for (let i = start + 1; i < lines.length && out.length < 20; i++) {
    if (lines[i].trim().startsWith('#')) break // next heading ends the block
    const m = lines[i].match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/)
    if (!m) continue
    let body = m[1].trim()
    let options: string[] | undefined
    if (body.includes('|')) {
      const segs = body.split('|').map((s) => s.trim()).filter(Boolean)
      body = segs.shift() ?? body
      options = segs.length ? segs.slice(0, 8) : undefined
    }
    body = body.replace(/^\*\*(.+?)\*\*/, '$1').trim() // drop leading bold a model may add
    if (body) out.push({ id: `q${out.length + 1}`, question: body, options })
  }
  return out
}

async function createAgentOutputArtifact(args: {
  instance: WorkflowInstance
  node: WorkflowNode
  runId: string
  content: string
  payload: Record<string, unknown>
  name?: string
}): Promise<string | undefined> {
  const content = args.content.trim()
  if (!content) return undefined
  const tenantId = args.instance.tenantId ?? undefined

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
  const name = args.name ?? `${args.node.label || args.node.id} output`
  const existing = await withTenantDbTransaction(prisma, (tx) => tx.consumable.findFirst({
    where: {
      typeId: type.id,
      instanceId: args.instance.id,
      nodeId: args.node.id,
      name,
    },
    select: { id: true, currentVersion: true },
  }), tenantId)
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
    await withTenantDbTransaction(prisma, (tx) => tx.consumable.update({
      where: { id: existing.id },
      data: {
        status: 'UNDER_REVIEW',
        currentVersion: nextVersion,
        formData: payload as Prisma.InputJsonValue,
      },
    }), tenantId)
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

  const created = await withTenantDbTransaction(prisma, (tx) => tx.consumable.create({
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
  }), tenantId)
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

// Whole-workflow Copilot opt-in (workflow.metadata.usesCopilot). When set, governed
// agents in this workflow route their LLM via the COPILOT_SDLC touch point (the
// Copilot gateway) instead of GOVERNED_AGENT. Overridable in the routing canvas.
async function resolveWorkflowUsesCopilot(templateId?: string | null): Promise<boolean> {
  if (!templateId) return false
  const workflow = await prisma.workflow.findUnique({
    where: { id: templateId },
    select: { metadata: true },
  })
  const metadata = isRecord(workflow?.metadata) ? workflow?.metadata : {}
  return metadata.usesCopilot === true
}

async function resolveWorkflowGovernanceMode(templateId: string | null | undefined, node: WorkflowNode): Promise<GovernanceMode> {
  const securityHint = `${node.nodeType} ${node.label}`.toLowerCase()
  if (securityHint.includes('security') || securityHint.includes('compliance') || securityHint.includes('policy')) {
    return 'fail_closed'
  }
  if (!templateId) return config.DEFAULT_GOVERNANCE_MODE as GovernanceMode
  const workflow = await prisma.workflow.findUnique({
    where: { id: templateId },
    select: { status: true, budgetPolicy: true, metadata: true },
  })
  const rawPolicy = isRecord(workflow?.budgetPolicy) ? workflow?.budgetPolicy : {}
  const nodeModes = isRecord(rawPolicy.nodeTypeGovernanceModes) ? rawPolicy.nodeTypeGovernanceModes : {}
  const nodeMode = nodeModes[String(node.nodeType)]
  if (isGovernanceMode(nodeMode)) return nodeMode
  if (isGovernanceMode(rawPolicy.governanceMode)) return rawPolicy.governanceMode
  const metadata = isRecord(workflow?.metadata) ? workflow?.metadata : {}
  const criticality = String(metadata.criticality ?? metadata.risk ?? '').toUpperCase()
  if (criticality === 'HIGH' || criticality === 'CRITICAL' || criticality === 'SOX' || criticality === 'PCI') {
    return 'human_approval_required'
  }
  if (workflow?.status && workflow.status !== 'DRAFT') return 'human_approval_required'
  return config.DEFAULT_GOVERNANCE_MODE as GovernanceMode
}

function isGovernanceMode(value: unknown): value is GovernanceMode {
  return value === 'fail_open'
    || value === 'fail_closed'
    || value === 'degraded'
    || value === 'human_approval_required'
}
