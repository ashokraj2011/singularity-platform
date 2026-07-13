import type { WorkflowInstance, WorkflowNode } from '@prisma/client'
import type { DirectLlmChatResult } from './DirectLlmHarness'
import {
  type DirectLlmTool,
  type DirectLlmToolContext,
  dispatchDirectLlmTool,
  validateAgainstContract,
} from './direct-llm-tools'

/**
 * The DIRECT workgraph→LLM agentic loop: a real model → call tool → observe →
 * decide → repeat cycle that runs ENTIRELY inside workgraph-api. It calls the
 * provider's HTTP API directly (Anthropic tool_use / OpenAI tool_calls), executes
 * tool calls in-process against the self-contained allowlist in `direct-llm-tools.ts`,
 * feeds the results back, and iterates — with NO MCP, NO context-fabric, and NO
 * governed phase machine.
 *
 * This is intentionally the ungoverned bypass path, so its safety rests on: (a) a
 * hard turn ceiling, (b) a per-turn tool-call cap, (c) a repeated-call no-progress
 * guard, and (d) the fact that every registered tool is read-only/pure. Real
 * tool-using work that needs governance belongs on the governed AGENT_TASK route.
 */

export type DirectLlmToolCall = { id: string; name: string; input: Record<string, unknown> }

// Provider-neutral running conversation; converted to each provider's native shape per call.
export type LoopMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: DirectLlmToolCall[] }
  | { role: 'tool'; results: { id: string; name: string; content: string; ok: boolean }[] }

export type DirectLlmToolDef = { name: string; description: string; inputSchema: Record<string, unknown> }

export type DirectLlmToolProviderRequest = {
  provider: string
  model: string
  baseUrl?: string
  modelAlias?: string
  credentialEnv?: string
  systemPrompt?: string
  temperature?: number
  maxTokens: number
  timeoutMs: number
  messages: LoopMessage[]
  tools: DirectLlmToolDef[]
}

export type DirectLlmToolProviderResult = {
  textContent: string
  toolCalls: DirectLlmToolCall[]
  stopReason: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  providerRequestId?: string
}

export type DirectLlmToolLoopOptions = {
  enabled: boolean
  maxTurns: number
  maxToolCallsPerTurn: number
  tools: DirectLlmTool[]
  unknownRequestedTools: string[]
  requiredOutputIncludes: string[]
  outputJsonSchema?: Record<string, unknown>
  validationMode: 'off' | 'soft' | 'hard'
  validationFailure?: 'REPAIR' | 'REVIEW' | 'BLOCK'
}

export type DirectLlmToolLoopTurn = {
  index: number
  textPreview: string
  stopReason: string
  toolCalls: { name: string; ok: boolean; resultPreview: string }[]
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  providerRequestId?: string
}

export type DirectLlmToolLoopReceipt = {
  mode: 'tool-loop'
  loopSource: 'workgraph-direct-tool-loop'
  bypassedContextFabric: true
  bypassedMcp: true
  toolsAllowed: string[]
  toolCallCount: number
  turns: DirectLlmToolLoopTurn[]
  stopReason: 'final-answer' | 'max-turns' | 'no-progress'
  validation: { mode: DirectLlmToolLoopOptions['validationMode']; passed: boolean; errors: string[] }
  warnings: string[]
}

export class DirectLlmToolLoopError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message)
    this.name = 'DirectLlmToolLoopError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function readJson(response: Response, source: string): Promise<Record<string, unknown>> {
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

// ── Anthropic (/v1/messages) tool turn ─────────────────────────────────────
export function toAnthropicMessages(messages: LoopMessage[]): unknown[] {
  return messages.map(message => {
    if (message.role === 'user') return { role: 'user', content: message.text }
    if (message.role === 'assistant') {
      const content: unknown[] = []
      if (message.text.trim()) content.push({ type: 'text', text: message.text })
      for (const call of message.toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
      return { role: 'assistant', content }
    }
    return {
      role: 'user',
      content: message.results.map(result => ({
        type: 'tool_result',
        tool_use_id: result.id,
        content: result.content,
        ...(result.ok ? {} : { is_error: true }),
      })),
    }
  })
}

async function anthropicToolTurn(req: DirectLlmToolProviderRequest, apiKey?: string): Promise<DirectLlmToolProviderResult> {
  const baseUrl = (req.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
      messages: toAnthropicMessages(req.messages),
      ...(req.tools.length ? { tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
    }),
    signal: AbortSignal.timeout(req.timeoutMs),
  })
  const data = await readJson(response, 'Anthropic LLM')
  return parseAnthropicToolResponse(data)
}

export function parseAnthropicToolResponse(data: Record<string, unknown>): DirectLlmToolProviderResult {
  const blocks = Array.isArray(data.content) ? data.content : []
  const textContent = blocks
    .map(block => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
  const toolCalls: DirectLlmToolCall[] = blocks
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'tool_use')
    .map(block => ({
      id: typeof block.id === 'string' ? block.id : '',
      name: typeof block.name === 'string' ? block.name : '',
      input: isRecord(block.input) ? block.input : {},
    }))
    .filter(call => call.name)
  const usage = isRecord(data.usage) ? data.usage : {}
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
  return {
    textContent,
    toolCalls,
    stopReason: typeof data.stop_reason === 'string' ? data.stop_reason : '',
    inputTokens,
    outputTokens,
    totalTokens: inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined,
    providerRequestId: typeof data.id === 'string' ? data.id : undefined,
  }
}

// ── OpenAI-compatible (/chat/completions) tool turn ────────────────────────
export function toOpenAiMessages(systemPrompt: string | undefined, messages: LoopMessage[]): unknown[] {
  const out: unknown[] = []
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt })
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.text })
    } else if (message.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: message.text || null,
        ...(message.toolCalls.length
          ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) }
          : {}),
      })
    } else {
      for (const result of message.results) out.push({ role: 'tool', tool_call_id: result.id, content: result.content })
    }
  }
  return out
}

async function openAiToolTurn(req: DirectLlmToolProviderRequest, apiKey?: string): Promise<DirectLlmToolProviderResult> {
  const baseUrl = (req.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: req.model,
      messages: toOpenAiMessages(req.systemPrompt, req.messages),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      ...(req.tools.length
        ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: 'auto' }
        : {}),
    }),
    signal: AbortSignal.timeout(req.timeoutMs),
  })
  const data = await readJson(response, 'OpenAI-compatible LLM')
  return parseOpenAiToolResponse(data)
}

export function parseOpenAiToolResponse(data: Record<string, unknown>): DirectLlmToolProviderResult {
  const choices = Array.isArray(data.choices) ? data.choices : []
  const first = isRecord(choices[0]) ? choices[0] : {}
  const message = isRecord(first.message) ? first.message : {}
  const textContent = typeof message.content === 'string' ? message.content : ''
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const toolCalls: DirectLlmToolCall[] = rawToolCalls
    .filter(isRecord)
    .map(call => {
      const fn = isRecord(call.function) ? call.function : {}
      return {
        id: typeof call.id === 'string' ? call.id : '',
        name: typeof fn.name === 'string' ? fn.name : '',
        input: typeof fn.arguments === 'string' ? safeJsonObject(fn.arguments) : {},
      }
    })
    .filter(call => call.name)
  const usage = isRecord(data.usage) ? data.usage : {}
  return {
    textContent,
    toolCalls,
    stopReason: typeof first.finish_reason === 'string' ? first.finish_reason : '',
    inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
    providerRequestId: typeof data.id === 'string' ? data.id : undefined,
  }
}

// Deterministic mock: never calls tools, echoes the latest input as the final answer,
// so a provider:'mock' node terminates on turn 1 instead of looping.
function mockToolTurn(req: DirectLlmToolProviderRequest): DirectLlmToolProviderResult {
  const last = [...req.messages].reverse().find(m => m.role === 'user' || m.role === 'tool')
  const text = last ? (last.role === 'user' ? last.text : last.results.map(r => r.content).join('\n')) : ''
  return {
    textContent: `Mock direct tool-loop answer:\n${text.slice(0, 1000)}`,
    toolCalls: [],
    stopReason: 'stop',
    inputTokens: 8,
    outputTokens: 8,
    totalTokens: 16,
    providerRequestId: `mock-tool-loop-${req.messages.length}`,
  }
}

export async function defaultCallToolProvider(req: DirectLlmToolProviderRequest): Promise<DirectLlmToolProviderResult> {
  if (req.provider === 'mock') return mockToolTurn(req)
  const apiKey = req.credentialEnv ? process.env[req.credentialEnv] : undefined
  if (!apiKey) {
    throw new DirectLlmToolLoopError(
      'DIRECT_LLM_TOOL_LOOP_NO_CREDENTIAL',
      `Missing API key env var ${req.credentialEnv ?? '(none configured)'} for direct tool-loop provider ${req.provider}.`,
    )
  }
  if (req.provider === 'anthropic') return anthropicToolTurn(req, apiKey)
  return openAiToolTurn(req, apiKey)
}

export type DirectLlmToolLoopLlm = {
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

export async function runDirectLlmToolLoop(args: {
  llm: DirectLlmToolLoopLlm
  options: DirectLlmToolLoopOptions
  node: WorkflowNode
  instance: WorkflowInstance
  traceId: string
  toolContext: DirectLlmToolContext
  callToolProvider?: (req: DirectLlmToolProviderRequest) => Promise<DirectLlmToolProviderResult>
}): Promise<{ chat: DirectLlmChatResult; receipt: DirectLlmToolLoopReceipt; reviewRequired: boolean }> {
  const { options } = args
  const call = args.callToolProvider ?? defaultCallToolProvider
  const toolDefs: DirectLlmToolDef[] = options.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  const warnings: string[] = []
  if (options.unknownRequestedTools.length) {
    warnings.push(`ignored unknown tools (not in the direct-path allowlist): ${options.unknownRequestedTools.join(', ')}`)
  }

  const messages: LoopMessage[] = [{ role: 'user', text: args.llm.prompt }]
  const turns: DirectLlmToolLoopTurn[] = []
  let aggregateInput = 0
  let aggregateOutput = 0
  let aggregateTotal = 0
  let finalText = ''
  let providerRequestId: string | undefined
  let toolCallCount = 0
  let stopReason: DirectLlmToolLoopReceipt['stopReason'] = 'max-turns'
  const maxTurns = Math.min(Math.max(Math.trunc(options.maxTurns || 1), 1), 12)
  const maxToolCallsPerTurn = Math.max(1, Math.trunc(options.maxToolCallsPerTurn || 1))
  let idSeq = 0
  let lastToolSignature = ''

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const res = await call({
      provider: args.llm.provider,
      model: args.llm.model,
      baseUrl: args.llm.baseUrl,
      modelAlias: args.llm.modelAlias,
      credentialEnv: args.llm.credentialEnv,
      systemPrompt: args.llm.systemPrompt,
      temperature: args.llm.temperature,
      maxTokens: args.llm.maxTokens,
      timeoutMs: args.llm.timeoutMs,
      messages,
      tools: toolDefs,
    })
    aggregateInput += res.inputTokens ?? 0
    aggregateOutput += res.outputTokens ?? 0
    aggregateTotal += res.totalTokens ?? ((res.inputTokens ?? 0) + (res.outputTokens ?? 0))
    providerRequestId = res.providerRequestId ?? providerRequestId
    if (res.textContent) finalText = res.textContent

    if (!res.toolCalls.length) {
      // No tool calls → the model has produced its final answer.
      turns.push({
        index: turn + 1,
        textPreview: res.textContent.slice(0, 400),
        stopReason: res.stopReason || 'stop',
        toolCalls: [],
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        totalTokens: res.totalTokens,
        providerRequestId: res.providerRequestId,
      })
      stopReason = 'final-answer'
      break
    }

    const executing = res.toolCalls.slice(0, maxToolCallsPerTurn)
    const withIds = executing.map(call2 => ({ ...call2, id: call2.id || `call_${(idSeq += 1)}` }))

    // No-progress guard: identical tool calls two turns running means we're stuck — stop
    // rather than burning the rest of the turn budget on the same request.
    const signature = JSON.stringify(withIds.map(call2 => [call2.name, call2.input]))
    if (signature === lastToolSignature) {
      warnings.push('stopped: the model repeated the same tool call(s) with no progress')
      turns.push({
        index: turn + 1,
        textPreview: res.textContent.slice(0, 400),
        stopReason: 'no-progress',
        toolCalls: withIds.map(call2 => ({ name: call2.name, ok: false, resultPreview: '(skipped — repeated call)' })),
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        totalTokens: res.totalTokens,
        providerRequestId: res.providerRequestId,
      })
      stopReason = 'no-progress'
      break
    }
    lastToolSignature = signature

    const results = withIds.map(call2 => {
      const result = dispatchDirectLlmTool(call2.name, call2.input, options.tools, args.toolContext)
      toolCallCount += 1
      return { id: call2.id, name: call2.name, content: result.content, ok: result.ok }
    })
    messages.push({ role: 'assistant', text: res.textContent, toolCalls: withIds })
    messages.push({ role: 'tool', results })
    turns.push({
      index: turn + 1,
      textPreview: res.textContent.slice(0, 400),
      stopReason: res.stopReason || 'tool_use',
      toolCalls: results.map(result => ({ name: result.name, ok: result.ok, resultPreview: result.content.slice(0, 200) })),
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      totalTokens: res.totalTokens,
      providerRequestId: res.providerRequestId,
    })
  }

  if (stopReason === 'max-turns') {
    warnings.push(`stopped: reached the ${maxTurns}-turn ceiling without a final answer`)
  }

  const validation = validateAgainstContract(finalText, options)
  if (!validation.passed && (options.validationMode === 'hard' || options.validationFailure === 'BLOCK')) {
    throw new DirectLlmToolLoopError('DIRECT_LLM_TOOL_LOOP_VALIDATION_FAILED', validation.errors.join('; '), { validation, turns })
  }

  return {
    chat: {
      content: finalText,
      inputTokens: aggregateInput || undefined,
      outputTokens: aggregateOutput || undefined,
      totalTokens: aggregateTotal || undefined,
      providerRequestId,
    },
    receipt: {
      mode: 'tool-loop',
      loopSource: 'workgraph-direct-tool-loop',
      bypassedContextFabric: true,
      bypassedMcp: true,
      toolsAllowed: options.tools.map(t => t.name),
      toolCallCount,
      turns,
      stopReason,
      validation: { mode: options.validationMode, ...validation },
      warnings,
    },
    reviewRequired: !validation.passed && (options.validationMode === 'soft' || options.validationFailure === 'REVIEW'),
  }
}
