import { createHash } from 'crypto'
import Ajv from 'ajv'
import type { WorkflowInstance, WorkflowNode } from '@prisma/client'
import type { ComposeArtifact, ComposeResponse, ResolveStageResponse } from '../../../../lib/prompt-composer/client'

export type DirectLlmChatResult = {
  content: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  providerRequestId?: string
}

export type DirectLlmProviderRequest = {
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
}

export type DirectLlmHarnessPhase =
  | 'PLAN'
  | 'EXPLORE'
  | 'ACT'
  | 'VERIFY'
  | 'REPAIR'
  | 'SELF_REVIEW'
  | 'FINALIZE'

export type DirectLlmHarnessOptions = {
  enabled: boolean
  composeWithPromptComposer: boolean
  agentTemplateId?: string
  agentBindingId?: string
  capabilityId?: string
  promptProfileKey?: string
  loopEnabled: boolean
  loopStageKey: string
  loopAgentRole?: string
  loopPhases: DirectLlmHarnessPhase[]
  maxTurns: number
  requiredOutputIncludes: string[]
  artifacts?: ComposeArtifact[]
  outputJsonSchema?: Record<string, unknown>
  validationMode: 'off' | 'soft' | 'hard'
  // Adaptive-loop controls (loop mode only). Both engage only when an output contract is configured
  // (validationMode !== 'off' and a required-text or JSON schema is present); otherwise the loop runs
  // exactly as before — every planned phase once, in order, validating only the final output.
  earlyStop?: boolean
  maxRepairAttempts?: number
}

export type DirectLlmHarnessTurn = {
  index: number
  phase: DirectLlmHarnessPhase | 'SINGLE'
  promptHash: string
  promptAssemblyId?: string
  promptProfileId?: string
  providerRequestId?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  validationPassed?: boolean
  validationErrors?: string[]
}

export type DirectLlmHarnessReceipt = {
  enabled: boolean
  mode: 'single' | 'loop'
  loopSource: 'workgraph-direct-harness'
  phaseProtocol: 'context-fabric-governed-loop-compatible'
  promptSource: 'prompt-composer-preview' | 'prompt-composer-stage' | 'node-inline'
  promptAssemblyId?: string
  promptHash?: string
  warnings: string[]
  validation: {
    mode: DirectLlmHarnessOptions['validationMode']
    passed: boolean
    errors: string[]
  }
  turns: DirectLlmHarnessTurn[]
  // Why the loop stopped, and how many bounded VERIFY→REPAIR turns it spent (loop mode only).
  stopReason?: 'converged' | 'phases-exhausted' | 'repair-exhausted' | 'turn-cap'
  repairAttempts?: number
}

type ComposePromptFn = (input: {
  llm: DirectLlmProviderRequest
  options: DirectLlmHarnessOptions
  node: WorkflowNode
  instance: WorkflowInstance
  traceId: string
}) => Promise<ComposeResponse>

type ResolveStagePromptFn = (input: {
  phase: DirectLlmHarnessPhase
  options: DirectLlmHarnessOptions
  node: WorkflowNode
  instance: WorkflowInstance
}) => Promise<ResolveStageResponse>

export class DirectLlmHarnessError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message)
    this.name = 'DirectLlmHarnessError'
  }
}

const ajv = new Ajv({ allErrors: true, strict: false })

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function clampTurns(phases: DirectLlmHarnessPhase[], maxTurns: number): DirectLlmHarnessPhase[] {
  const limit = Math.min(Math.max(maxTurns || 1, 1), 12)
  return phases.slice(0, limit)
}

function safeJsonParseObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced?.[1]) {
      try {
        const parsed = JSON.parse(fenced[1])
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
      } catch {
        // Fall through to embedded-object extraction below.
      }
    }
    const embedded = trimmed.match(/\{[\s\S]*\}/)
    if (!embedded?.[0]) return null
    try {
      const parsed = JSON.parse(embedded[0])
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
}

function validateHarnessOutput(content: string, options: DirectLlmHarnessOptions): { passed: boolean; errors: string[] } {
  if (options.validationMode === 'off') return { passed: true, errors: [] }
  const errors: string[] = []
  const lower = content.toLowerCase()
  for (const required of options.requiredOutputIncludes) {
    if (required && !lower.includes(required.toLowerCase())) {
      errors.push(`missing required output text: ${required}`)
    }
  }
  if (options.outputJsonSchema) {
    const parsed = safeJsonParseObject(content)
    if (!parsed) {
      errors.push('output is not parseable JSON for configured schema validation')
    } else {
      const valid = ajv.validate(options.outputJsonSchema, parsed)
      if (!valid) {
        errors.push(...(ajv.errors ?? []).map(err => `${err.instancePath || '/'} ${err.message ?? 'schema validation failed'}`))
      }
    }
  }
  return { passed: errors.length === 0, errors }
}

function appendSections(...sections: Array<string | undefined>): string | undefined {
  const text = sections.map(section => section?.trim()).filter(Boolean).join('\n\n')
  return text || undefined
}

async function defaultComposePrompt(input: Parameters<ComposePromptFn>[0]): Promise<ComposeResponse> {
  const { promptComposerClient } = await import('../../../../lib/prompt-composer/client')
  const context = input.instance.context && typeof input.instance.context === 'object' && !Array.isArray(input.instance.context)
    ? input.instance.context as Record<string, unknown>
    : {}
  const vars = context._vars && typeof context._vars === 'object' && !Array.isArray(context._vars)
    ? context._vars as Record<string, unknown>
    : context.vars && typeof context.vars === 'object' && !Array.isArray(context.vars)
      ? context.vars as Record<string, unknown>
      : {}
  const globals = context._globals && typeof context._globals === 'object' && !Array.isArray(context._globals)
    ? context._globals as Record<string, unknown>
    : context.globals && typeof context.globals === 'object' && !Array.isArray(context.globals)
      ? context.globals as Record<string, unknown>
      : {}

  return promptComposerClient.composeAndRespond({
    agentTemplateId: input.options.agentTemplateId!,
    agentBindingId: input.options.agentBindingId,
    capabilityId: input.options.capabilityId,
    task: input.llm.prompt,
    workflowContext: {
      instanceId: input.instance.id,
      nodeId: input.node.id,
      traceId: input.traceId,
      vars,
      globals,
      priorOutputs: {},
    },
    artifacts: input.options.artifacts ?? [],
    overrides: {
      additionalLayers: [],
      systemPromptAppend: input.llm.systemPrompt,
    },
    modelOverrides: {
      modelAlias: input.llm.modelAlias,
      temperature: input.llm.temperature,
      maxOutputTokens: input.llm.maxTokens,
    },
    toolDiscovery: { enabled: false, riskMax: 'low', limit: 0 },
    previewOnly: true,
  })
}

async function defaultResolveStagePrompt(input: Parameters<ResolveStagePromptFn>[0]): Promise<ResolveStageResponse> {
  const { promptComposerClient } = await import('../../../../lib/prompt-composer/client')
  return promptComposerClient.resolveStage({
    stageKey: input.options.loopStageKey,
    agentRole: input.options.loopAgentRole,
    phase: input.phase,
    promptProfileKey: input.options.promptProfileKey,
    vars: {
      workflowInstanceId: input.instance.id,
      workflowNodeId: input.node.id,
      nodeLabel: input.node.label,
      nodeType: input.node.nodeType,
    },
  })
}

function phasePrompt(args: {
  phase: DirectLlmHarnessPhase
  basePrompt: string
  priorTurns: DirectLlmHarnessTurn[]
  priorOutputs: string[]
  stage?: ResolveStageResponse
  repairFeedback?: { errors: string[]; failingOutput: string }
}): string {
  const prior = args.priorOutputs.length
    ? `Prior direct harness outputs:\n${args.priorOutputs.map((text, i) => `Turn ${i + 1}:\n${text}`).join('\n\n')}`
    : 'Prior direct harness outputs: none.'
  const phaseInstruction = [
    `Direct LLM harness phase: ${args.phase}.`,
    'This is a direct model call. Do not claim that Context Fabric, MCP, tools, shell commands, or repository writes were executed.',
    'Use the phase discipline from the governed loop: produce a concrete phase result, identify uncertainty, and make the next phase easier to validate.',
    args.phase === 'REPAIR'
      ? 'Revise the previous output so it satisfies the output contract. Fix every listed validation failure and return the corrected final answer only.'
      : args.phase === 'FINALIZE' || args.phase === 'SELF_REVIEW'
        ? 'Return the final answer or review-ready output with clear evidence and residual risks.'
        : 'Return phase output that can feed the next phase.',
  ].join('\n')

  // On a REPAIR turn, feed the concrete contract failures (and the output that failed) back to the model.
  const repair = args.repairFeedback
    ? [
        'Validation of the previous output FAILED against the output contract. Correct ALL of these problems:',
        args.repairFeedback.errors.map(error => `- ${error}`).join('\n'),
        '',
        'Previous output that failed validation:',
        args.repairFeedback.failingOutput,
      ].join('\n')
    : undefined

  return appendSections(args.stage?.task, args.basePrompt, prior, repair, phaseInstruction) ?? args.basePrompt
}

export async function runDirectLlmHarness(args: {
  llm: DirectLlmProviderRequest
  options: DirectLlmHarnessOptions
  node: WorkflowNode
  instance: WorkflowInstance
  traceId: string
  callProvider: (request: DirectLlmProviderRequest) => Promise<DirectLlmChatResult>
  composePrompt?: ComposePromptFn
  resolveStagePrompt?: ResolveStagePromptFn
}): Promise<{
  chat: DirectLlmChatResult
  receipt: DirectLlmHarnessReceipt
  reviewRequired: boolean
}> {
  const options = args.options
  const warnings: string[] = []
  const turns: DirectLlmHarnessTurn[] = []
  let promptSource: DirectLlmHarnessReceipt['promptSource'] = 'node-inline'
  let basePrompt = args.llm.prompt
  let baseSystemPrompt = args.llm.systemPrompt
  let promptAssemblyId: string | undefined
  let promptHash: string | undefined

  if (options.enabled && options.composeWithPromptComposer && options.agentTemplateId) {
    try {
      const compose = await (args.composePrompt ?? defaultComposePrompt)({
        llm: args.llm,
        options,
        node: args.node,
        instance: args.instance,
        traceId: args.traceId,
      })
      if (compose.assembled?.message) basePrompt = compose.assembled.message
      if (compose.assembled?.systemPrompt) baseSystemPrompt = appendSections(compose.assembled.systemPrompt, args.llm.systemPrompt)
      promptAssemblyId = compose.promptAssemblyId
      promptHash = compose.promptHash
      promptSource = 'prompt-composer-preview'
      warnings.push(...(compose.warnings ?? []).map(warning => `prompt-composer: ${warning}`))
    } catch (err) {
      warnings.push(`prompt-composer preview unavailable; using node prompt: ${(err as Error).message}`)
    }
  }

  if (!options.enabled || !options.loopEnabled) {
    const request = { ...args.llm, prompt: basePrompt, systemPrompt: baseSystemPrompt }
    const chat = await args.callProvider(request)
    const validation = validateHarnessOutput(chat.content, options)
    turns.push({
      index: 1,
      phase: 'SINGLE',
      promptHash: stableHash(`${request.systemPrompt ?? ''}\n${request.prompt}`),
      promptAssemblyId,
      providerRequestId: chat.providerRequestId,
      inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens,
      totalTokens: chat.totalTokens,
      validationPassed: validation.passed,
      validationErrors: validation.errors,
    })
    if (!validation.passed && options.validationMode === 'hard') {
      throw new DirectLlmHarnessError('DIRECT_LLM_HARNESS_VALIDATION_FAILED', validation.errors.join('; '), { validation, turns })
    }
    return {
      chat,
      receipt: {
        enabled: options.enabled,
        mode: 'single',
        loopSource: 'workgraph-direct-harness',
        phaseProtocol: 'context-fabric-governed-loop-compatible',
        promptSource,
        promptAssemblyId,
        promptHash,
        warnings,
        validation: { mode: options.validationMode, ...validation },
        turns,
      },
      reviewRequired: !validation.passed && options.validationMode === 'soft',
    }
  }

  const phases = clampTurns(options.loopPhases.length ? options.loopPhases : ['PLAN', 'SELF_REVIEW'], options.maxTurns)
  // Hard ceiling on total provider calls this run (planned phases + any REPAIR turns). Reuses
  // clampTurns' ≤12 bound so REPAIR can never push the loop past the configured turn budget.
  const ceiling = Math.min(Math.max(options.maxTurns || 1, 1), 12)
  // Early-stop and VERIFY→REPAIR engage ONLY when there is a real output contract to converge on.
  // With no contract the loop is byte-for-byte the old behavior: run every planned phase once, in order.
  const contractConfigured = options.validationMode !== 'off'
    && (options.requiredOutputIncludes.some(text => text.trim().length > 0) || Boolean(options.outputJsonSchema))
  const earlyStop = options.earlyStop ?? true
  const maxRepairAttempts = Math.max(0, Math.trunc(options.maxRepairAttempts ?? 3))
  const isReviewPhase = (phase: DirectLlmHarnessPhase): boolean =>
    phase === 'VERIFY' || phase === 'SELF_REVIEW' || phase === 'FINALIZE'

  const outputs: string[] = []
  let finalChat: DirectLlmChatResult | null = null
  let aggregateInput = 0
  let aggregateOutput = 0
  let aggregateTotal = 0
  let repairAttempts = 0
  let stopReason: DirectLlmHarnessReceipt['stopReason'] = 'phases-exhausted'

  // One provider turn: resolve the stage prompt, call the model, aggregate tokens, validate, record.
  const runPhase = async (
    phase: DirectLlmHarnessPhase,
    repairFeedback?: { errors: string[]; failingOutput: string },
  ): Promise<{ chat: DirectLlmChatResult; validation: { passed: boolean; errors: string[] } }> => {
    let stage: ResolveStageResponse | undefined
    try {
      stage = await (args.resolveStagePrompt ?? defaultResolveStagePrompt)({
        phase,
        options,
        node: args.node,
        instance: args.instance,
      })
      promptSource = promptSource === 'prompt-composer-preview' ? promptSource : 'prompt-composer-stage'
    } catch (err) {
      warnings.push(`prompt-composer stage prompt unavailable for ${phase}; using generic phase prompt: ${(err as Error).message}`)
    }
    const request = {
      ...args.llm,
      prompt: phasePrompt({ phase, basePrompt, priorTurns: turns, priorOutputs: outputs, stage, repairFeedback }),
      systemPrompt: appendSections(baseSystemPrompt, stage?.systemPromptAppend, stage?.extraContext),
    }
    const chat = await args.callProvider(request)
    outputs.push(chat.content)
    aggregateInput += chat.inputTokens ?? 0
    aggregateOutput += chat.outputTokens ?? 0
    aggregateTotal += chat.totalTokens ?? ((chat.inputTokens ?? 0) + (chat.outputTokens ?? 0))
    // Validate after EVERY phase now (was: only the last) — this is what drives early-stop and REPAIR.
    const validation = validateHarnessOutput(chat.content, options)
    turns.push({
      index: turns.length + 1,
      phase,
      promptHash: stableHash(`${request.systemPrompt ?? ''}\n${request.prompt}`),
      promptAssemblyId,
      promptProfileId: stage?.promptProfileId,
      providerRequestId: chat.providerRequestId,
      inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens,
      totalTokens: chat.totalTokens,
      validationPassed: validation.passed,
      validationErrors: validation.errors,
    })
    return { chat, validation }
  }

  for (let i = 0; i < phases.length && turns.length < ceiling; i += 1) {
    const phase = phases[i]
    let { chat, validation } = await runPhase(phase)
    finalChat = chat

    // Bounded VERIFY→REPAIR: when a review phase fails the contract, feed the concrete errors back into
    // a REPAIR turn and re-validate. Mirrors the governed loop's max_repair_attempts, capped by `ceiling`.
    while (
      contractConfigured
      && isReviewPhase(phase)
      && !validation.passed
      && repairAttempts < maxRepairAttempts
      && turns.length < ceiling
    ) {
      repairAttempts += 1
      ;({ chat, validation } = await runPhase('REPAIR', { errors: validation.errors, failingOutput: chat.content }))
      finalChat = chat
    }

    // Early-stop on convergence: once the output satisfies the contract there is nothing to add, so skip
    // the remaining planned phases instead of parroting through them.
    if (contractConfigured && earlyStop && validation.passed) {
      stopReason = 'converged'
      if (i < phases.length - 1) {
        warnings.push(`early-stop: output contract satisfied at ${phase} (turn ${turns.length}); skipped ${phases.length - 1 - i} remaining phase(s)`)
      }
      break
    }
  }

  // Classify a non-converged stop for the receipt (observability only).
  if (stopReason === 'phases-exhausted') {
    if (turns.length >= ceiling) stopReason = 'turn-cap'
    else if (repairAttempts > 0 && turns[turns.length - 1]?.validationPassed === false) stopReason = 'repair-exhausted'
  }

  const finalValidation = turns[turns.length - 1]?.validationPassed === false
    ? { passed: false, errors: turns[turns.length - 1]?.validationErrors ?? [] }
    : validateHarnessOutput(finalChat?.content ?? '', options)
  if (!finalValidation.passed && options.validationMode === 'hard') {
    throw new DirectLlmHarnessError('DIRECT_LLM_HARNESS_VALIDATION_FAILED', finalValidation.errors.join('; '), { validation: finalValidation, turns })
  }

  return {
    chat: {
      content: finalChat?.content ?? '',
      inputTokens: aggregateInput || finalChat?.inputTokens,
      outputTokens: aggregateOutput || finalChat?.outputTokens,
      totalTokens: aggregateTotal || finalChat?.totalTokens,
      providerRequestId: finalChat?.providerRequestId,
    },
    receipt: {
      enabled: true,
      mode: 'loop',
      loopSource: 'workgraph-direct-harness',
      phaseProtocol: 'context-fabric-governed-loop-compatible',
      promptSource,
      promptAssemblyId,
      promptHash,
      warnings,
      validation: { mode: options.validationMode, ...finalValidation },
      turns,
      stopReason,
      repairAttempts,
    },
    reviewRequired: !finalValidation.passed && options.validationMode === 'soft',
  }
}
