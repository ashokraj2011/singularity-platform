import { Prisma } from '@prisma/client'
import type { WorkflowInstance, WorkflowNode } from '@prisma/client'
import { prisma } from '../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../lib/audit'
import { ValidationError } from '../../../lib/errors'

export type BudgetEnforcementMode = 'PAUSE_FOR_APPROVAL' | 'FAIL_HARD' | 'WARN_ONLY'
export type GovernanceMode = 'fail_open' | 'fail_closed' | 'degraded' | 'human_approval_required'

export type WorkflowBudgetPolicy = {
  defaultModelAlias?: string | null
  maxInputTokens?: number | null
  maxOutputTokens?: number | null
  maxTotalTokens?: number | null
  maxEstimatedCost?: number | null
  warnAtPercent: number
  enforcementMode: BudgetEnforcementMode
  governanceMode?: GovernanceMode
  nodeTypeGovernanceModes?: Record<string, GovernanceMode>
  nodeTypeDefaults?: Record<string, {
    inputTokenBudget?: number
    outputTokenBudget?: number
    maxContextTokens?: number
    maxOutputTokens?: number
  }>
}

type UsageDelta = {
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  estimatedCost?: number | null
  provider?: string | null
  model?: string | null
  nodeId?: string | null
  agentRunId?: string | null
  cfCallId?: string | null
  promptAssemblyId?: string | null
  metadata?: Record<string, unknown>
}

type LlmBudgetInput = {
  instance: WorkflowInstance
  node: WorkflowNode
  agentRunId?: string
  contextPolicy: Record<string, unknown>
  limits: Record<string, unknown>
  modelOverrides: Record<string, unknown>
}

type LlmBudgetDecision =
  | { action: 'ALLOW'; contextPolicy: Record<string, unknown>; limits: Record<string, unknown>; modelOverrides: Record<string, unknown>; warnings: string[] }
  | { action: 'BLOCKED'; reason: string }
  | { action: 'FAIL'; reason: string }

export const DEFAULT_WORKFLOW_BUDGET_POLICY: WorkflowBudgetPolicy = {
  maxInputTokens: 100_000,
  maxOutputTokens: 25_000,
  maxTotalTokens: 125_000,
  maxEstimatedCost: null,
  warnAtPercent: 80,
  enforcementMode: 'PAUSE_FOR_APPROVAL',
  governanceMode: 'fail_open',
  nodeTypeGovernanceModes: {
    SECURITY_REVIEW: 'fail_closed',
    POLICY_CHECK: 'fail_closed',
  },
  nodeTypeDefaults: {
    AGENT_TASK: {
      inputTokenBudget: 6_000,
      outputTokenBudget: 1_200,
      maxContextTokens: 6_000,
      maxOutputTokens: 1_200,
    },
    WORKBENCH_TASK: {
      inputTokenBudget: 6_000,
      outputTokenBudget: 1_200,
      maxContextTokens: 6_000,
      maxOutputTokens: 1_200,
    },
  },
}

export function normalizeBudgetPolicy(input: unknown): WorkflowBudgetPolicy {
  const raw = isRecord(input) ? input : {}
  const defaults = DEFAULT_WORKFLOW_BUDGET_POLICY
  return {
    defaultModelAlias: typeof raw.defaultModelAlias === 'string' && raw.defaultModelAlias.trim() ? raw.defaultModelAlias.trim() : null,
    maxInputTokens: positiveIntOrNull(raw.maxInputTokens, defaults.maxInputTokens),
    maxOutputTokens: positiveIntOrNull(raw.maxOutputTokens, defaults.maxOutputTokens),
    maxTotalTokens: positiveIntOrNull(raw.maxTotalTokens, defaults.maxTotalTokens),
    maxEstimatedCost: positiveNumberOrNull(raw.maxEstimatedCost, defaults.maxEstimatedCost),
    warnAtPercent: clampInt(raw.warnAtPercent, 1, 100, defaults.warnAtPercent),
    enforcementMode: isEnforcementMode(raw.enforcementMode) ? raw.enforcementMode : defaults.enforcementMode,
    governanceMode: isGovernanceMode(raw.governanceMode) ? raw.governanceMode : defaults.governanceMode,
    nodeTypeGovernanceModes: mergeGovernanceModes(defaults.nodeTypeGovernanceModes, raw.nodeTypeGovernanceModes),
    nodeTypeDefaults: mergeNodeDefaults(defaults.nodeTypeDefaults, raw.nodeTypeDefaults),
  }
}

export function applyRunBudgetOverride(baseInput: unknown, overrideInput: unknown): WorkflowBudgetPolicy {
  const base = normalizeBudgetPolicy(baseInput)
  if (!isRecord(overrideInput)) return base
  const next = normalizeBudgetPolicy({ ...base, ...overrideInput })

  assertNotRaised('maxInputTokens', base.maxInputTokens, next.maxInputTokens)
  assertNotRaised('maxOutputTokens', base.maxOutputTokens, next.maxOutputTokens)
  assertNotRaised('maxTotalTokens', base.maxTotalTokens, next.maxTotalTokens)
  assertNotRaised('maxEstimatedCost', base.maxEstimatedCost, next.maxEstimatedCost)

  return next
}

export async function createWorkflowRunBudgetSnapshot(
  tx: Prisma.TransactionClient,
  opts: {
    instanceId: string
    templateId?: string | null
    templatePolicy?: unknown
    runOverride?: unknown
  },
) {
  const policy = applyRunBudgetOverride(opts.templatePolicy, opts.runOverride)
  const created = await tx.workflowRunBudget.create({
    data: {
      instanceId: opts.instanceId,
      templateId: opts.templateId ?? null,
      policy: policy as unknown as Prisma.InputJsonValue,
      maxInputTokens: policy.maxInputTokens ?? null,
      maxOutputTokens: policy.maxOutputTokens ?? null,
      maxTotalTokens: policy.maxTotalTokens ?? null,
      maxEstimatedCost: policy.maxEstimatedCost ?? null,
      warnAtPercent: policy.warnAtPercent,
      enforcementMode: policy.enforcementMode as any,
      events: {
        create: {
          instanceId: opts.instanceId,
          eventType: 'SNAPSHOT_CREATED' as any,
          metadata: {
            templateId: opts.templateId ?? null,
            policy,
          } as Prisma.InputJsonValue,
        },
      },
    },
  })
  return created
}

export async function ensureWorkflowRunBudget(instanceId: string) {
  const existing = await prisma.workflowRunBudget.findUnique({
    where: { instanceId },
    include: { events: { orderBy: { createdAt: 'desc' }, take: 200 } },
  })
  if (existing) return existing

  const instance = await prisma.workflowInstance.findUnique({
    where: { id: instanceId },
    include: { template: { select: { id: true, budgetPolicy: true } } },
  })
  if (!instance) throw new ValidationError(`WorkflowInstance ${instanceId} not found`)

  await createWorkflowRunBudgetSnapshot(prisma as unknown as Prisma.TransactionClient, {
    instanceId,
    templateId: instance.templateId,
    templatePolicy: instance.template?.budgetPolicy,
  })
  return prisma.workflowRunBudget.findUniqueOrThrow({
    where: { instanceId },
    include: { events: { orderBy: { createdAt: 'desc' }, take: 200 } },
  })
}

export async function prepareLlmBudget(input: LlmBudgetInput): Promise<LlmBudgetDecision> {
  const budget = await ensureWorkflowRunBudget(input.instance.id)
  const remaining = remainingBudget(budget)
  const warnings: string[] = []
  const policy = normalizeBudgetPolicy(budget.policy)
  const nodeDefaults = policy.nodeTypeDefaults?.[input.node.nodeType] ?? {}

  if (isBudgetExhausted(remaining)) {
    const reason = 'Workflow run token/cost budget is exhausted.'
    if (budget.enforcementMode === 'FAIL_HARD') {
      await recordBudgetEvent(budget.id, input.instance.id, {
        eventType: 'BUDGET_EXCEEDED',
        nodeId: input.node.id,
        agentRunId: input.agentRunId,
        metadata: { reason, remaining },
      })
      return { action: 'FAIL', reason }
    }
    if (budget.enforcementMode === 'WARN_ONLY') {
      await recordBudgetEvent(budget.id, input.instance.id, {
        eventType: 'BUDGET_EXCEEDED',
        nodeId: input.node.id,
        agentRunId: input.agentRunId,
        metadata: { reason, remaining, enforcementMode: 'WARN_ONLY' },
      })
      warnings.push(reason)
    } else {
      await blockForBudgetApproval(input.instance, input.node, budget.id, input.agentRunId, reason, remaining)
      return { action: 'BLOCKED', reason }
    }
  }

  const limits = { ...input.limits }
  const contextPolicy = { ...input.contextPolicy }
  const modelOverrides = { ...input.modelOverrides }

  const requestedInput = intFrom(limits.inputTokenBudget) ?? intFrom(contextPolicy.maxContextTokens) ?? nodeDefaults.inputTokenBudget
  const requestedOutput = intFrom(limits.outputTokenBudget) ?? intFrom(modelOverrides.maxOutputTokens) ?? nodeDefaults.outputTokenBudget
  const clampedInput = clampToRemaining(requestedInput, remaining.inputTokens)
  const clampedOutput = clampToRemaining(requestedOutput, remaining.outputTokens)

  if (clampedInput !== undefined) {
    limits.inputTokenBudget = clampedInput
    contextPolicy.maxContextTokens = Math.min(
      intFrom(contextPolicy.maxContextTokens) ?? clampedInput,
      clampedInput,
    )
  }
  if (clampedOutput !== undefined) {
    limits.outputTokenBudget = clampedOutput
    modelOverrides.maxOutputTokens = Math.min(
      intFrom(modelOverrides.maxOutputTokens) ?? clampedOutput,
      clampedOutput,
    )
  }
  if (remaining.totalTokens !== null) {
    const currentMaxPrompt = intFrom(limits.maxPromptChars)
    if (currentMaxPrompt !== undefined) limits.maxPromptChars = currentMaxPrompt
  }

  if ((requestedInput !== undefined && clampedInput !== requestedInput) || (requestedOutput !== undefined && clampedOutput !== requestedOutput)) {
    warnings.push('LLM call budget was clamped to the remaining workflow run budget.')
    await recordBudgetEvent(budget.id, input.instance.id, {
      eventType: 'PRECHECK_CLAMPED',
      nodeId: input.node.id,
      agentRunId: input.agentRunId,
      metadata: { requestedInput, requestedOutput, clampedInput, clampedOutput, remaining },
    })
  }

  return { action: 'ALLOW', contextPolicy, limits, modelOverrides, warnings }
}

export async function recordWorkflowLlmUsage(instanceId: string, usage: UsageDelta) {
  const budget = await ensureWorkflowRunBudget(instanceId)
  const input = positiveInt(usage.inputTokens)
  const output = positiveInt(usage.outputTokens)
  const total = positiveInt(usage.totalTokens) ?? input + output
  const estimatedCost = positiveNumber(usage.estimatedCost)
  const pricingStatus = estimatedCost === null ? 'UNPRICED' : 'PRICED'

  const updated = await prisma.$transaction(async tx => {
    const current = await tx.workflowRunBudget.findUniqueOrThrow({ where: { id: budget.id } })
    const consumedInputTokens = current.consumedInputTokens + input
    const consumedOutputTokens = current.consumedOutputTokens + output
    const consumedTotalTokens = current.consumedTotalTokens + total
    const consumedEstimatedCost = current.consumedEstimatedCost + (estimatedCost ?? 0)
    const nextStatus = computeStatus(current, {
      consumedInputTokens,
      consumedOutputTokens,
      consumedTotalTokens,
      consumedEstimatedCost,
      pricingStatus,
    })

    const row = await tx.workflowRunBudget.update({
      where: { id: budget.id },
      data: {
        consumedInputTokens,
        consumedOutputTokens,
        consumedTotalTokens,
        consumedEstimatedCost,
        pricingStatus: pricingStatus === 'UNPRICED' ? 'UNPRICED' : current.pricingStatus,
        status: nextStatus as any,
        warningEmittedAt: nextStatus === 'WARNED' && !current.warningEmittedAt ? new Date() : current.warningEmittedAt,
        exceededAt: (nextStatus === 'EXCEEDED' || nextStatus === 'EXHAUSTED') && !current.exceededAt ? new Date() : current.exceededAt,
      },
    })
    await tx.workflowRunBudgetEvent.create({
      data: {
        budgetId: budget.id,
        instanceId,
        nodeId: usage.nodeId ?? null,
        agentRunId: usage.agentRunId ?? null,
        cfCallId: usage.cfCallId ?? null,
        promptAssemblyId: usage.promptAssemblyId ?? null,
        eventType: 'USAGE_RECORDED' as any,
        inputTokensDelta: input,
        outputTokensDelta: output,
        totalTokensDelta: total,
        estimatedCostDelta: estimatedCost,
        pricingStatus,
        metadata: {
          provider: usage.provider ?? null,
          model: usage.model ?? null,
          ...(usage.metadata ?? {}),
        } as Prisma.InputJsonValue,
      },
    })
    if (pricingStatus === 'UNPRICED') {
      await tx.workflowRunBudgetEvent.create({
        data: {
          budgetId: budget.id,
          instanceId,
          nodeId: usage.nodeId ?? null,
          agentRunId: usage.agentRunId ?? null,
          cfCallId: usage.cfCallId ?? null,
          promptAssemblyId: usage.promptAssemblyId ?? null,
          eventType: 'UNPRICED_USAGE' as any,
          pricingStatus,
          metadata: { reason: 'Context Fabric returned token usage without estimated cost.' } as Prisma.InputJsonValue,
        },
      })
    }
    if (nextStatus === 'WARNED' && !current.warningEmittedAt) {
      await tx.workflowRunBudgetEvent.create({
        data: {
          budgetId: budget.id,
          instanceId,
          nodeId: usage.nodeId ?? null,
          agentRunId: usage.agentRunId ?? null,
          cfCallId: usage.cfCallId ?? null,
          promptAssemblyId: usage.promptAssemblyId ?? null,
          eventType: 'WARN_THRESHOLD' as any,
          metadata: { warnAtPercent: current.warnAtPercent } as Prisma.InputJsonValue,
        },
      })
    }
    if ((nextStatus === 'EXCEEDED' || nextStatus === 'EXHAUSTED') && !current.exceededAt) {
      await tx.workflowRunBudgetEvent.create({
        data: {
          budgetId: budget.id,
          instanceId,
          nodeId: usage.nodeId ?? null,
          agentRunId: usage.agentRunId ?? null,
          cfCallId: usage.cfCallId ?? null,
          promptAssemblyId: usage.promptAssemblyId ?? null,
          eventType: 'BUDGET_EXCEEDED' as any,
          metadata: { status: nextStatus } as Prisma.InputJsonValue,
        },
      })
    }
    return row
  })

  await logEvent('WorkflowBudgetUsageRecorded', 'WorkflowRunBudget', updated.id, undefined, {
    instanceId,
    nodeId: usage.nodeId,
    agentRunId: usage.agentRunId,
    cfCallId: usage.cfCallId,
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    estimatedCost,
    pricingStatus,
    status: updated.status,
  })
  await publishOutbox('WorkflowRunBudget', updated.id, 'WorkflowBudgetUsageRecorded', {
    instanceId,
    budgetId: updated.id,
    status: updated.status,
  })
  return updated
}

export async function getWorkflowBudgetOverview(instanceId: string) {
  const budget = await ensureWorkflowRunBudget(instanceId)
  const events = await prisma.workflowRunBudgetEvent.findMany({
    where: { budgetId: budget.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  const remaining = remainingBudget(budget)
  return {
    ...budget,
    remaining,
    percentUsed: {
      inputTokens: percent(budget.consumedInputTokens, budget.maxInputTokens),
      outputTokens: percent(budget.consumedOutputTokens, budget.maxOutputTokens),
      totalTokens: percent(budget.consumedTotalTokens, budget.maxTotalTokens),
      estimatedCost: percent(budget.consumedEstimatedCost, budget.maxEstimatedCost),
    },
    warnings: buildBudgetWarnings(budget),
    events,
  }
}

export async function approveBudgetIncreaseFromApproval(requestId: string, actorId: string) {
  const request = await prisma.approvalRequest.findUnique({ where: { id: requestId } })
  if (!request || request.subjectType !== 'WorkflowRunBudget') return false
  const payload = isRecord(request.formData) ? request.formData : {}
  const budgetId = request.subjectId
  const budget = await prisma.workflowRunBudget.findUnique({ where: { id: budgetId } })
  if (!budget) return false

  const addInput = positiveInt(payload.requestedInputTokens)
  const addOutput = positiveInt(payload.requestedOutputTokens)
  const addTotal = positiveInt(payload.requestedTotalTokens)
  const addCost = positiveNumber(payload.requestedEstimatedCost)

  await prisma.$transaction(async tx => {
    await tx.workflowRunBudget.update({
      where: { id: budgetId },
      data: {
        maxInputTokens: addInput > 0 ? (budget.maxInputTokens ?? budget.consumedInputTokens) + addInput : budget.maxInputTokens,
        maxOutputTokens: addOutput > 0 ? (budget.maxOutputTokens ?? budget.consumedOutputTokens) + addOutput : budget.maxOutputTokens,
        maxTotalTokens: addTotal > 0 ? (budget.maxTotalTokens ?? budget.consumedTotalTokens) + addTotal : budget.maxTotalTokens,
        maxEstimatedCost: addCost !== null ? (budget.maxEstimatedCost ?? budget.consumedEstimatedCost) + addCost : budget.maxEstimatedCost,
        status: 'ACTIVE' as any,
        pausedAt: null,
      },
    })
    await tx.workflowRunBudgetEvent.create({
      data: {
        budgetId,
        instanceId: request.instanceId ?? budget.instanceId,
        nodeId: request.nodeId,
        eventType: 'EXTRA_APPROVED' as any,
        metadata: {
          requestId,
          actorId,
          addInput,
          addOutput,
          addTotal,
          addCost,
        } as Prisma.InputJsonValue,
      },
    })
    if (request.instanceId) {
      await tx.workflowInstance.update({
        where: { id: request.instanceId },
        data: { status: 'ACTIVE' as any },
      })
    }
    if (request.nodeId) {
      await tx.workflowNode.update({
        where: { id: request.nodeId },
        data: { status: 'ACTIVE' as any },
      })
    }
  })

  await logEvent('WorkflowBudgetIncreaseApproved', 'WorkflowRunBudget', budgetId, actorId, {
    requestId,
    instanceId: request.instanceId,
    nodeId: request.nodeId,
  })
  await publishOutbox('WorkflowRunBudget', budgetId, 'WorkflowBudgetIncreaseApproved', {
    budgetId,
    requestId,
    instanceId: request.instanceId,
    nodeId: request.nodeId,
  })
  return true
}

function remainingBudget(budget: {
  maxInputTokens: number | null
  maxOutputTokens: number | null
  maxTotalTokens: number | null
  maxEstimatedCost: number | null
  consumedInputTokens: number
  consumedOutputTokens: number
  consumedTotalTokens: number
  consumedEstimatedCost: number
}) {
  return {
    inputTokens: budget.maxInputTokens === null ? null : Math.max(0, budget.maxInputTokens - budget.consumedInputTokens),
    outputTokens: budget.maxOutputTokens === null ? null : Math.max(0, budget.maxOutputTokens - budget.consumedOutputTokens),
    totalTokens: budget.maxTotalTokens === null ? null : Math.max(0, budget.maxTotalTokens - budget.consumedTotalTokens),
    estimatedCost: budget.maxEstimatedCost === null ? null : Math.max(0, budget.maxEstimatedCost - budget.consumedEstimatedCost),
  }
}

function isBudgetExhausted(remaining: ReturnType<typeof remainingBudget>) {
  return remaining.inputTokens === 0 || remaining.outputTokens === 0 || remaining.totalTokens === 0 || remaining.estimatedCost === 0
}

async function blockForBudgetApproval(
  instance: WorkflowInstance,
  node: WorkflowNode,
  budgetId: string,
  agentRunId: string | undefined,
  reason: string,
  remaining: ReturnType<typeof remainingBudget>,
) {
  const requestedInputTokens = 10_000
  const requestedOutputTokens = 2_000
  await prisma.$transaction(async tx => {
    await tx.workflowRunBudget.update({
      where: { id: budgetId },
      data: { status: 'PAUSED' as any, pausedAt: new Date() },
    })
    await tx.workflowRunBudgetEvent.create({
      data: {
        budgetId,
        instanceId: instance.id,
        nodeId: node.id,
        agentRunId: agentRunId ?? null,
        eventType: 'PRECHECK_BLOCKED' as any,
        metadata: {
          reason,
          remaining,
          requestedInputTokens,
          requestedOutputTokens,
        } as Prisma.InputJsonValue,
      },
    })
    await tx.workflowInstance.update({
      where: { id: instance.id },
      data: { status: 'PAUSED' as any },
    })
    await tx.workflowNode.update({
      where: { id: node.id },
      data: { status: 'BLOCKED' as any },
    })
    await tx.approvalRequest.create({
      data: {
        instanceId: instance.id,
        nodeId: node.id,
        subjectType: 'WorkflowRunBudget',
        subjectId: budgetId,
        requestedById: instance.createdById ?? 'system',
        assignmentMode: 'DIRECT_USER',
        assignedToId: instance.createdById ?? undefined,
        status: 'PENDING',
        formData: {
          reason,
          nodeType: node.nodeType,
          nodeLabel: node.label,
          requestedInputTokens,
          requestedOutputTokens,
          requestedTotalTokens: requestedInputTokens + requestedOutputTokens,
          requestedEstimatedCost: null,
        } as Prisma.InputJsonValue,
      },
    })
  })
  await logEvent('WorkflowBudgetApprovalRequested', 'WorkflowRunBudget', budgetId, instance.createdById ?? undefined, {
    instanceId: instance.id,
    nodeId: node.id,
    reason,
  })
  await publishOutbox('WorkflowRunBudget', budgetId, 'WorkflowBudgetApprovalRequested', {
    budgetId,
    instanceId: instance.id,
    nodeId: node.id,
  })
}

async function recordBudgetEvent(
  budgetId: string,
  instanceId: string,
  input: {
    eventType: string
    nodeId?: string
    agentRunId?: string
    metadata?: Record<string, unknown>
  },
) {
  await prisma.workflowRunBudgetEvent.create({
    data: {
      budgetId,
      instanceId,
      nodeId: input.nodeId ?? null,
      agentRunId: input.agentRunId ?? null,
      eventType: input.eventType as any,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  })
}

function computeStatus(
  budget: {
    maxInputTokens: number | null
    maxOutputTokens: number | null
    maxTotalTokens: number | null
    maxEstimatedCost: number | null
    warnAtPercent: number
    status: unknown
  },
  next: {
    consumedInputTokens: number
    consumedOutputTokens: number
    consumedTotalTokens: number
    consumedEstimatedCost: number
    pricingStatus: string
  },
): WorkflowRunBudgetStatusString {
  if (isAtOrOver(next.consumedInputTokens, budget.maxInputTokens) ||
      isAtOrOver(next.consumedOutputTokens, budget.maxOutputTokens) ||
      isAtOrOver(next.consumedTotalTokens, budget.maxTotalTokens) ||
      isAtOrOver(next.consumedEstimatedCost, budget.maxEstimatedCost)) {
    return 'EXHAUSTED'
  }
  if (isWarn(next.consumedInputTokens, budget.maxInputTokens, budget.warnAtPercent) ||
      isWarn(next.consumedOutputTokens, budget.maxOutputTokens, budget.warnAtPercent) ||
      isWarn(next.consumedTotalTokens, budget.maxTotalTokens, budget.warnAtPercent) ||
      isWarn(next.consumedEstimatedCost, budget.maxEstimatedCost, budget.warnAtPercent)) {
    return 'WARNED'
  }
  return budget.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE'
}

type WorkflowRunBudgetStatusString = 'ACTIVE' | 'WARNED' | 'PAUSED' | 'EXCEEDED' | 'EXHAUSTED'

function buildBudgetWarnings(budget: {
  status: unknown
  pricingStatus: string
  consumedInputTokens: number
  maxInputTokens: number | null
  consumedOutputTokens: number
  maxOutputTokens: number | null
  consumedTotalTokens: number
  maxTotalTokens: number | null
  consumedEstimatedCost: number
  maxEstimatedCost: number | null
  warnAtPercent: number
}) {
  const warnings: string[] = []
  if (budget.status === 'WARNED') warnings.push(`Workflow budget has reached at least ${budget.warnAtPercent}% usage.`)
  if (budget.status === 'EXCEEDED' || budget.status === 'EXHAUSTED') warnings.push('Workflow budget has been exhausted or exceeded.')
  if (budget.pricingStatus === 'UNPRICED') warnings.push('Some LLM calls returned token usage without estimated cost.')
  return warnings
}

function mergeNodeDefaults(
  defaults: WorkflowBudgetPolicy['nodeTypeDefaults'],
  input: unknown,
): WorkflowBudgetPolicy['nodeTypeDefaults'] {
  const merged: WorkflowBudgetPolicy['nodeTypeDefaults'] = { ...(defaults ?? {}) }
  if (!isRecord(input)) return merged
  for (const [nodeType, value] of Object.entries(input)) {
    if (!isRecord(value)) continue
    merged[nodeType] = {
      ...(merged[nodeType] ?? {}),
      inputTokenBudget: positiveIntOrUndefined(value.inputTokenBudget),
      outputTokenBudget: positiveIntOrUndefined(value.outputTokenBudget),
      maxContextTokens: positiveIntOrUndefined(value.maxContextTokens),
      maxOutputTokens: positiveIntOrUndefined(value.maxOutputTokens),
    }
  }
  return merged
}

function assertNotRaised(key: string, base: number | null | undefined, next: number | null | undefined) {
  if (base !== null && base !== undefined && next !== null && next !== undefined && next > base) {
    throw new ValidationError(`Run budget override cannot raise ${key} above the workflow template policy`)
  }
}

function positiveInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function positiveIntOrUndefined(value: unknown): number | undefined {
  const n = positiveInt(value)
  return n > 0 ? n : undefined
}

function positiveIntOrNull(value: unknown, fallback: number | null | undefined): number | null {
  if (value === null) return null
  const n = positiveInt(value)
  if (n > 0) return n
  return fallback ?? null
}

function positiveNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function positiveNumberOrNull(value: unknown, fallback: number | null | undefined): number | null {
  if (value === null) return null
  const n = positiveNumber(value)
  if (n !== null) return n
  return fallback ?? null
}

function intFrom(value: unknown): number | undefined {
  const n = positiveInt(value)
  return n > 0 ? n : undefined
}

function clampToRemaining(requested: number | undefined, remaining: number | null): number | undefined {
  if (requested === undefined) return remaining === null ? undefined : remaining
  if (remaining === null) return requested
  return Math.max(0, Math.min(requested, remaining))
}

function percent(consumed: number, max: number | null): number | null {
  if (!max || max <= 0) return null
  return Math.round((consumed / max) * 1000) / 10
}

function isAtOrOver(consumed: number, max: number | null): boolean {
  return max !== null && max > 0 && consumed >= max
}

function isWarn(consumed: number, max: number | null, threshold: number): boolean {
  return max !== null && max > 0 && (consumed / max) * 100 >= threshold
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = positiveInt(value)
  if (n <= 0) return fallback
  return Math.max(min, Math.min(max, n))
}

function isEnforcementMode(value: unknown): value is BudgetEnforcementMode {
  return value === 'PAUSE_FOR_APPROVAL' || value === 'FAIL_HARD' || value === 'WARN_ONLY'
}

function isGovernanceMode(value: unknown): value is GovernanceMode {
  return value === 'fail_open' || value === 'fail_closed' || value === 'degraded' || value === 'human_approval_required'
}

function mergeGovernanceModes(
  defaults: WorkflowBudgetPolicy['nodeTypeGovernanceModes'],
  raw: unknown,
): Record<string, GovernanceMode> {
  const out: Record<string, GovernanceMode> = { ...(defaults ?? {}) }
  if (!isRecord(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (isGovernanceMode(value)) out[key] = value
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
