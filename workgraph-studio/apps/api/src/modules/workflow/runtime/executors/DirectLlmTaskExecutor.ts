import { Prisma, type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { workflowNodeTraceId } from '@workgraph/shared-types'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import { recordWorkflowLlmUsage } from '../budget'
import {
  DirectLlmHarnessError,
  runDirectLlmHarness,
  type DirectLlmChatResult,
  type DirectLlmHarnessOptions,
  type DirectLlmHarnessPhase,
  type DirectLlmProviderRequest,
} from './DirectLlmHarness'

type DirectLlmOutput = {
  directLlm: {
    passed: boolean
    provider?: string
    model?: string
    modelAlias?: string
    response?: string
    traceId?: string
    agentRunId?: string
    artifactId?: string
    reviewRequired?: boolean
    bypassedRuntimeFabric: true
    harness?: Record<string, unknown>
    usage?: {
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
    }
    error?: string
    code?: string
  }
}

type DirectLlmResult =
  | { passed: true; reviewRequired: boolean; output: DirectLlmOutput }
  | { passed: false; output: DirectLlmOutput }

type ResolvedDirectLlmConfig = {
  provider: string
  model: string
  baseUrl?: string
  modelAlias?: string
  credentialEnv?: string
  systemPrompt?: string
  prompt: string
  temperature?: number
  maxTokens: number
  timeoutMs: number
  reviewRequired: boolean
  outputPath?: string
  harness: DirectLlmHarnessOptions
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cfgValue(node: WorkflowNode, key: string): unknown {
  const cfg = isRecord(node.config) ? node.config : {}
  const standard = isRecord(cfg.standard) ? cfg.standard : {}
  return cfg[key] ?? standard[key]
}

function harnessValue(node: WorkflowNode, key: string): unknown {
  const cfg = isRecord(node.config) ? node.config : {}
  const standard = isRecord(cfg.standard) ? cfg.standard : {}
  const harness = isRecord(cfg.harness)
    ? cfg.harness
    : isRecord(cfg.directLlmHarness)
      ? cfg.directLlmHarness
      : isRecord(standard.harness)
        ? standard.harness
        : isRecord(standard.directLlmHarness)
          ? standard.directLlmHarness
          : {}
  return harness[key] ?? cfg[key] ?? standard[key]
}

function cfgString(node: WorkflowNode, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = cfgValue(node, key)
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function cfgNumber(node: WorkflowNode, key: string, fallback: number): number {
  const value = cfgValue(node, key)
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

function cfgBool(node: WorkflowNode, key: string, fallback: boolean): boolean {
  const value = cfgValue(node, key)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y'].includes(v)) return true
    if (['false', '0', 'no', 'n'].includes(v)) return false
  }
  return fallback
}

function harnessString(node: WorkflowNode, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = harnessValue(node, key)
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function harnessNumber(node: WorkflowNode, key: string, fallback: number): number {
  const value = harnessValue(node, key)
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

function harnessBool(node: WorkflowNode, key: string, fallback: boolean): boolean {
  const value = harnessValue(node, key)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y'].includes(v)) return true
    if (['false', '0', 'no', 'n'].includes(v)) return false
  }
  return fallback
}

function harnessStringArray(node: WorkflowNode, key: string, fallback: string[] = []): string[] {
  const value = harnessValue(node, key)
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean)
  return fallback
}

function harnessJsonObject(node: WorkflowNode, key: string): Record<string, unknown> | undefined {
  const value = harnessValue(node, key)
  if (isRecord(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return isRecord(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

function nestedLookup(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && !Array.isArray(acc)) return (acc as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function interpolate(template: string, instance: WorkflowInstance, node: WorkflowNode): string {
  const context = isRecord(instance.context) ? instance.context : {}
  const vars = isRecord(context._vars) ? context._vars : isRecord(context.vars) ? context.vars : {}
  const globals = isRecord(context._globals) ? context._globals : isRecord(context.globals) ? context.globals : {}
  const scope: Record<string, unknown> = {
    context,
    vars,
    globals,
    instance: { id: instance.id, templateId: instance.templateId, createdById: instance.createdById },
    node: { id: node.id, label: node.label, type: node.nodeType },
  }
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath) => {
    const value = nestedLookup(scope, String(rawPath).trim())
    if (value == null) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return JSON.stringify(value)
  })
}

function defaultCredentialEnv(provider: string): string | undefined {
  const p = provider.toLowerCase()
  if (p === 'anthropic') return 'ANTHROPIC_API_KEY'
  if (p === 'openai' || p === 'openai_compatible' || p === 'openai-compatible') return 'OPENAI_API_KEY'
  if (p === 'copilot' || p === 'github_copilot') return 'COPILOT_PROVIDER_API_KEY'
  return undefined
}

function normalizeProvider(provider: string): string {
  const p = provider.trim().toLowerCase().replace(/-/g, '_')
  if (p === 'openai_compatible' || p === 'openai' || p === 'anthropic' || p === 'mock' || p === 'copilot' || p === 'github_copilot') return p
  return p || 'openai_compatible'
}

const HARNESS_PHASES = new Set<DirectLlmHarnessPhase>([
  'PLAN',
  'EXPLORE',
  'ACT',
  'VERIFY',
  'REPAIR',
  'SELF_REVIEW',
  'FINALIZE',
])

function normalizeHarnessPhases(values: string[]): DirectLlmHarnessPhase[] {
  const phases = values
    .map(value => value.trim().toUpperCase())
    .filter((value): value is DirectLlmHarnessPhase => HARNESS_PHASES.has(value as DirectLlmHarnessPhase))
  return phases.length ? Array.from(new Set(phases)) : ['PLAN', 'SELF_REVIEW']
}

function resolveHarnessOptions(node: WorkflowNode): DirectLlmHarnessOptions {
  const agentTemplateId = harnessString(node, 'agentTemplateId', 'profileId', 'templateId')
  const loopEnabled = harnessBool(node, 'loopEnabled', harnessBool(node, 'useLoop', false))
  const validationRaw = (harnessString(node, 'validationMode') ?? 'soft').toLowerCase()
  const validationMode = validationRaw === 'hard' || validationRaw === 'off' ? validationRaw : 'soft'
  return {
    enabled: harnessBool(node, 'enabled', true),
    composeWithPromptComposer: harnessBool(node, 'composeWithPromptComposer', Boolean(agentTemplateId)),
    agentTemplateId,
    agentBindingId: harnessString(node, 'agentBindingId'),
    capabilityId: harnessString(node, 'capabilityId', 'governingCapabilityId'),
    promptProfileKey: harnessString(node, 'promptProfileKey'),
    loopEnabled,
    loopStageKey: harnessString(node, 'loopStageKey', 'stageKey') ?? 'loop.stage',
    loopAgentRole: harnessString(node, 'loopAgentRole', 'agentRole'),
    loopPhases: normalizeHarnessPhases(harnessStringArray(node, 'loopPhases', loopEnabled ? ['PLAN', 'SELF_REVIEW'] : [])),
    maxTurns: Math.min(Math.max(Math.trunc(harnessNumber(node, 'maxTurns', loopEnabled ? 3 : 1)), 1), 12),
    requiredOutputIncludes: harnessStringArray(node, 'requiredOutputIncludes'),
    outputJsonSchema: harnessJsonObject(node, 'outputJsonSchema'),
    validationMode,
  }
}

async function resolveDirectLlmConfig(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<{ config: ResolvedDirectLlmConfig } | { error: string; code: string }> {
  const alias = cfgString(node, 'connectionAlias', 'modelAlias', 'llmAlias')
  const connection = alias
    ? await prisma.llmConnection.findUnique({ where: { alias } }).catch(() => null)
    : null

  if (alias && connection && !connection.enabled) {
    return { error: `LLM connection alias "${alias}" is disabled.`, code: 'DIRECT_LLM_CONNECTION_DISABLED' }
  }

  const provider = normalizeProvider(
    cfgString(node, 'provider') ?? connection?.provider ?? (connection?.baseUrl ? 'openai_compatible' : 'mock'),
  )
  const model = cfgString(node, 'model') ?? connection?.model ?? (provider === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o-mini')
  const baseUrl = cfgString(node, 'baseUrl') ?? connection?.baseUrl ?? undefined
  const credentialEnv = cfgString(node, 'credentialEnv') ?? connection?.credentialEnv ?? defaultCredentialEnv(provider)
  const task = cfgString(node, 'task', 'prompt', 'userPrompt')
  if (!task) return { error: 'DIRECT_LLM_TASK requires a task/prompt.', code: 'DIRECT_LLM_NO_PROMPT' }

  const maxTokens = Math.min(Math.max(cfgNumber(node, 'maxTokens', 1200), 1), 32_000)
  const timeoutMs = Math.min(Math.max(cfgNumber(node, 'timeoutMs', cfgNumber(node, 'timeoutSec', 120) * 1000), 1_000), 600_000)
  const modelAlias = alias ?? connection?.alias ?? undefined
  return {
    config: {
      provider,
      model,
      baseUrl,
      modelAlias,
      credentialEnv,
      systemPrompt: cfgString(node, 'systemPrompt'),
      prompt: interpolate(task, instance, node),
      temperature: cfgNumber(node, 'temperature', 0.2),
      maxTokens,
      timeoutMs,
      reviewRequired: cfgBool(node, 'reviewRequired', false),
      outputPath: cfgString(node, 'outputPath', 'artifactName'),
      harness: resolveHarnessOptions(node),
    },
  }
}

async function parseJsonResponse(response: Response, source: string): Promise<Record<string, unknown>> {
  const text = await response.text()
  let data: unknown = {}
  if (text.trim()) {
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`${source} returned invalid JSON: ${text.slice(0, 500)}`)
    }
  }
  if (!response.ok) {
    const message = isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string'
      ? data.error.message
      : text.slice(0, 700) || `${source} returned HTTP ${response.status}`
    throw new Error(message)
  }
  if (!isRecord(data)) throw new Error(`${source} returned a non-object response.`)
  return data
}

async function callOpenAiCompatible(args: DirectLlmProviderRequest, apiKey?: string): Promise<DirectLlmChatResult> {
  const baseUrl = (args.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: args.model,
      messages: [
        ...(args.systemPrompt ? [{ role: 'system', content: args.systemPrompt }] : []),
        { role: 'user', content: args.prompt },
      ],
      temperature: args.temperature,
      max_tokens: args.maxTokens,
    }),
    signal: AbortSignal.timeout(args.timeoutMs),
  })
  const data = await parseJsonResponse(response, 'OpenAI-compatible LLM')
  const choices = Array.isArray(data.choices) ? data.choices : []
  const first = isRecord(choices[0]) ? choices[0] : {}
  const message = isRecord(first.message) ? first.message : {}
  const content = typeof message.content === 'string' ? message.content : ''
  const usage = isRecord(data.usage) ? data.usage : {}
  return {
    content,
    inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
    providerRequestId: typeof data.id === 'string' ? data.id : undefined,
  }
}

async function callAnthropic(args: DirectLlmProviderRequest, apiKey?: string): Promise<DirectLlmChatResult> {
  const baseUrl = (args.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: args.maxTokens,
      temperature: args.temperature,
      ...(args.systemPrompt ? { system: args.systemPrompt } : {}),
      messages: [{ role: 'user', content: args.prompt }],
    }),
    signal: AbortSignal.timeout(args.timeoutMs),
  })
  const data = await parseJsonResponse(response, 'Anthropic LLM')
  const blocks = Array.isArray(data.content) ? data.content : []
  const content = blocks
    .map(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')
    .filter(Boolean)
    .join('\n')
  const usage = isRecord(data.usage) ? data.usage : {}
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
  return {
    content,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined,
    providerRequestId: typeof data.id === 'string' ? data.id : undefined,
  }
}

async function callProvider(args: DirectLlmProviderRequest): Promise<DirectLlmChatResult> {
  if (args.provider === 'mock') {
    return {
      content: `Mock direct LLM response for ${args.modelAlias ?? args.model}:\n\n${args.prompt.slice(0, 2000)}`,
      inputTokens: Math.ceil(args.prompt.length / 4),
      outputTokens: 64,
      totalTokens: Math.ceil(args.prompt.length / 4) + 64,
      providerRequestId: `mock-${Date.now()}`,
    }
  }

  if ((args.provider === 'copilot' || args.provider === 'github_copilot') && !args.baseUrl) {
    throw new Error('Direct Copilot LLM requires an OpenAI-compatible Copilot bridge baseUrl; no default public Copilot chat URL is assumed.')
  }
  const apiKey = args.credentialEnv ? process.env[args.credentialEnv] : undefined
  if (!apiKey) {
    throw new Error(`Missing API key env var ${args.credentialEnv ?? '(none configured)'} for direct LLM provider ${args.provider}.`)
  }

  if (args.provider === 'anthropic') return callAnthropic(args, apiKey)
  return callOpenAiCompatible(args, apiKey)
}

async function createDirectLlmArtifact(args: {
  instance: WorkflowInstance
  node: WorkflowNode
  runId: string
  content: string
  payload: Record<string, unknown>
  reviewRequired: boolean
  name?: string
}): Promise<string | undefined> {
  const content = args.content.trim()
  if (!content) return undefined
  const tenantId = args.instance.tenantId ?? undefined
  const type = await prisma.consumableType.upsert({
    where: { name: 'DIRECT_LLM_OUTPUT' },
    update: {},
    create: {
      name: 'DIRECT_LLM_OUTPUT',
      description: 'Direct WorkGraph LLM output. This bypasses Context Fabric and MCP.',
      requiresApproval: args.reviewRequired,
      allowVersioning: true,
      schemaDef: {},
    },
  })
  const payload = {
    artifactType: 'direct_llm_output',
    approvalRequired: args.reviewRequired,
    agentRunId: args.runId,
    nodeId: args.node.id,
    nodeLabel: args.node.label,
    content,
    receipt: args.payload,
  }
  const created = await withTenantDbTransaction(prisma, (tx) => tx.consumable.create({
    data: {
      typeId: type.id,
      instanceId: args.instance.id,
      nodeId: args.node.id,
      name: args.name ?? `${args.node.label || args.node.id} direct LLM output`,
      status: args.reviewRequired ? 'UNDER_REVIEW' : 'APPROVED',
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
  await logEvent('DirectLlmOutputArtifactCreated', 'Consumable', created.id, args.instance.createdById ?? undefined, {
    runId: args.runId,
    nodeId: args.node.id,
    reviewRequired: args.reviewRequired,
  })
  await publishOutbox('Consumable', created.id, 'DirectLlmOutputArtifactCreated', {
    consumableId: created.id,
    runId: args.runId,
    nodeId: args.node.id,
  })
  return created.id
}

function failed(code: string, error: string): DirectLlmResult {
  return {
    passed: false,
    output: {
      directLlm: {
        passed: false,
        error,
        code,
        bypassedRuntimeFabric: true,
      },
    },
  }
}

export async function activateDirectLlmTask(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<DirectLlmResult> {
  const dbTenantId = instance.tenantId ?? undefined
  const resolved = await resolveDirectLlmConfig(node, instance)
  if ('error' in resolved) return failed(resolved.code, resolved.error)
  const llm = resolved.config

  const traceId = workflowNodeTraceId({
    prefix: 'direct-llm',
    workflowInstanceId: instance.id,
    workflowNodeId: node.id,
  })
  const agent = await withTenantDbTransaction(prisma, (tx) => tx.agent.create({
    data: {
      name: `Direct LLM: ${node.label || node.id}`,
      description: 'Workflow node that calls an LLM directly from WorkGraph API, bypassing Context Fabric and MCP.',
      provider: llm.provider.toUpperCase(),
      model: llm.model,
      systemPrompt: llm.systemPrompt,
      isActive: true,
    },
  }), dbTenantId)
  const run = await withTenantDbTransaction(prisma, (tx) => tx.agentRun.create({
    data: {
      agentId: agent.id,
      instanceId: instance.id,
      tenantId: instance.tenantId ?? null,
      nodeId: node.id,
      attempt: node.attempt,
      status: 'RUNNING',
      origin: 'workflow-direct-llm',
      client: 'workgraph-api-direct',
      traceId,
      initiatedById: actorId ?? instance.createdById ?? undefined,
      startedAt: new Date(),
      inputs: {
        create: {
          inputType: 'DIRECT_LLM_REQUEST',
          payload: {
            provider: llm.provider,
            model: llm.model,
            modelAlias: llm.modelAlias,
            baseUrl: llm.baseUrl,
            credentialEnv: llm.credentialEnv,
            prompt: llm.prompt,
            systemPrompt: llm.systemPrompt,
            temperature: llm.temperature,
            maxTokens: llm.maxTokens,
            timeoutMs: llm.timeoutMs,
            reviewRequired: llm.reviewRequired,
            harness: llm.harness,
            bypassedRuntimeFabric: true,
          } as Prisma.InputJsonValue,
        },
      },
    },
  }), dbTenantId)

  await logEvent('DirectLlmRunStarted', 'AgentRun', run.id, actorId, {
    nodeId: node.id,
    instanceId: instance.id,
    provider: llm.provider,
    model: llm.model,
    modelAlias: llm.modelAlias,
    bypassedRuntimeFabric: true,
  })
  await publishOutbox('AgentRun', run.id, 'DirectLlmRunStarted', { runId: run.id, nodeId: node.id })

  let chat: DirectLlmChatResult
  let harnessReceipt: Record<string, unknown> | undefined
  let harnessReviewRequired = false
  try {
    const harness = await runDirectLlmHarness({
      llm,
      options: llm.harness,
      node,
      instance,
      traceId,
      callProvider,
    })
    chat = harness.chat
    harnessReceipt = harness.receipt as unknown as Record<string, unknown>
    harnessReviewRequired = harness.reviewRequired
  } catch (err) {
    const message = (err as Error).message
    const code = err instanceof DirectLlmHarnessError ? err.code : 'DIRECT_LLM_PROVIDER_ERROR'
    await prisma.agentRunOutput.create({
      data: {
        runId: run.id,
        outputType: 'ERROR',
        rawContent: message,
        structuredPayload: {
          errorCode: code,
          traceId,
          ...(err instanceof DirectLlmHarnessError ? { harness: err.details } : {}),
        } as Prisma.InputJsonValue,
      },
    })
    await withTenantDbTransaction(prisma, (tx) => tx.agentRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', completedAt: new Date() },
    }), dbTenantId)
    await logEvent('DirectLlmRunFailed', 'AgentRun', run.id, actorId, {
      nodeId: node.id,
      instanceId: instance.id,
      code,
      error: message,
    })
    await publishOutbox('AgentRun', run.id, 'DirectLlmRunFailed', { runId: run.id })
    return failed(code, message)
  }
  const reviewRequired = llm.reviewRequired || harnessReviewRequired

  const usage = {
    inputTokens: chat.inputTokens,
    outputTokens: chat.outputTokens,
    totalTokens: chat.totalTokens,
  }
  const correlation: Record<string, unknown> = {
    traceId,
    modelCallId: chat.providerRequestId,
    modelAlias: llm.modelAlias,
    provider: llm.provider,
    model: llm.model,
    baseUrl: llm.baseUrl,
    credentialEnv: llm.credentialEnv,
    bypassedRuntimeFabric: true,
    bypassedContextFabric: true,
    bypassedMcp: true,
    reviewRequired,
    usage,
    harness: harnessReceipt,
  }

  await prisma.agentRunOutput.create({
    data: {
      runId: run.id,
      outputType: 'EXECUTION_TRACE',
      rawContent: traceId,
      structuredPayload: correlation as Prisma.InputJsonValue,
    },
  })
  await prisma.agentRunOutput.create({
    data: {
      runId: run.id,
      outputType: 'LLM_RESPONSE',
      rawContent: chat.content,
      structuredPayload: correlation as Prisma.InputJsonValue,
      tokenCount: chat.totalTokens ?? chat.inputTokens ?? null,
    },
  })

  const artifactId = await createDirectLlmArtifact({
    instance,
    node,
    runId: run.id,
    content: chat.content,
    payload: correlation,
    reviewRequired,
    name: llm.outputPath,
  })
  if (artifactId) correlation.artifactId = artifactId
  if (artifactId) {
    await prisma.agentRunOutput.updateMany({
      where: { runId: run.id, outputType: 'LLM_RESPONSE' },
      data: { structuredPayload: correlation as Prisma.InputJsonValue },
    })
  }

  await withTenantDbTransaction(prisma, (tx) => tx.agentRun.update({
    where: { id: run.id },
    data: {
      status: reviewRequired ? 'AWAITING_REVIEW' : 'APPROVED',
      completedAt: new Date(),
      modelCallId: chat.providerRequestId,
    },
  }), dbTenantId)

  await recordWorkflowLlmUsage(instance.id, {
    nodeId: node.id,
    agentRunId: run.id,
    inputTokens: chat.inputTokens,
    outputTokens: chat.outputTokens,
    totalTokens: chat.totalTokens,
    provider: llm.provider,
    model: llm.model,
    metadata: {
      modelAlias: llm.modelAlias,
      direct: true,
      bypassedRuntimeFabric: true,
      modelCallId: chat.providerRequestId,
    },
  }, dbTenantId).catch(err => logEvent('WorkflowBudgetUsageRecordFailed', 'WorkflowInstance', instance.id, actorId, {
    nodeId: node.id,
    agentRunId: run.id,
    error: (err as Error).message,
  }))

  await logEvent('DirectLlmRunCompleted', 'AgentRun', run.id, actorId, {
    nodeId: node.id,
    instanceId: instance.id,
    modelCallId: chat.providerRequestId,
    reviewRequired,
    usage,
    harness: harnessReceipt,
  })
  await publishOutbox('AgentRun', run.id, 'DirectLlmRunCompleted', {
    runId: run.id,
    nodeId: node.id,
    reviewRequired,
  })

  return {
    passed: true,
    reviewRequired: llm.reviewRequired,
    output: {
      directLlm: {
        passed: true,
        provider: llm.provider,
        model: llm.model,
        modelAlias: llm.modelAlias,
        response: chat.content,
        traceId,
        agentRunId: run.id,
        artifactId,
        reviewRequired,
        bypassedRuntimeFabric: true,
        harness: harnessReceipt,
        usage,
      },
    },
  }
}
