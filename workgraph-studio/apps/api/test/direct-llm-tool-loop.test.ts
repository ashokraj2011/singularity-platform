import { describe, expect, it } from 'vitest'
import {
  runDirectLlmToolLoop,
  toAnthropicMessages,
  toOpenAiMessages,
  parseAnthropicToolResponse,
  parseOpenAiToolResponse,
  type DirectLlmToolLoopLlm,
  type DirectLlmToolLoopOptions,
  type DirectLlmToolProviderRequest,
  type DirectLlmToolProviderResult,
  type LoopMessage,
} from '../src/modules/workflow/runtime/executors/DirectLlmToolLoop'
import {
  DIRECT_LLM_TOOL_REGISTRY,
  dispatchDirectLlmTool,
  resolveDirectLlmTools,
  validateAgainstContract,
  type DirectLlmToolContext,
} from '../src/modules/workflow/runtime/executors/direct-llm-tools'

const node = { id: 'n1', label: 'Direct', nodeType: 'DIRECT_LLM_TASK', config: {} } as any
const instance = {
  id: 'i1',
  templateId: 't1',
  createdById: 'u1',
  tenantId: 'tn1',
  context: { vars: { story: 'build it' }, globals: { capability: 'cap-1' } },
} as any

function llm(overrides: Partial<DirectLlmToolLoopLlm> = {}): DirectLlmToolLoopLlm {
  return { provider: 'mock', model: 'm', maxTokens: 800, timeoutMs: 60_000, prompt: 'do the task', temperature: 0.2, ...overrides }
}

function toolLoopOptions(overrides: Partial<DirectLlmToolLoopOptions> = {}): DirectLlmToolLoopOptions {
  const { tools } = resolveDirectLlmTools(null)
  return {
    enabled: true,
    maxTurns: 6,
    maxToolCallsPerTurn: 4,
    tools,
    unknownRequestedTools: [],
    requiredOutputIncludes: [],
    validationMode: 'soft',
    ...overrides,
  }
}

function toolCtx(overrides: Partial<DirectLlmToolContext> = {}): DirectLlmToolContext {
  return { instance, node, requiredOutputIncludes: [], ...overrides }
}

// A provider that records a deep snapshot of the conversation it was called with
// (so we can prove the loop fed tool results back BEFORE the next model call).
function recordingProvider(responder: (turn: number, req: DirectLlmToolProviderRequest) => DirectLlmToolProviderResult) {
  const snapshots: Array<{ messageCount: number; messages: any[]; toolNames: string[] }> = []
  let turn = 0
  const fn = async (req: DirectLlmToolProviderRequest): Promise<DirectLlmToolProviderResult> => {
    snapshots.push({ messageCount: req.messages.length, messages: JSON.parse(JSON.stringify(req.messages)), toolNames: req.tools.map(t => t.name) })
    return responder(turn++, req)
  }
  return { fn, snapshots }
}

function scripted(script: DirectLlmToolProviderResult[]) {
  return recordingProvider(turn => script[Math.min(turn, script.length - 1)])
}

describe('direct LLM tool loop', () => {
  it('calls a tool, feeds the result back, then terminates on the final answer', async () => {
    const provider = scripted([
      { textContent: 'let me check', toolCalls: [{ id: 't1', name: 'read_context', input: { path: 'vars.story' } }], stopReason: 'tool_use' },
      { textContent: 'Final: the story is "build it". APPROVED', toolCalls: [], stopReason: 'stop' },
    ])
    const result = await runDirectLlmToolLoop({
      llm: llm(),
      options: toolLoopOptions({ requiredOutputIncludes: ['APPROVED'] }),
      node,
      instance,
      traceId: 'trace-1',
      toolContext: toolCtx({ requiredOutputIncludes: ['APPROVED'] }),
      callToolProvider: provider.fn,
    })

    expect(provider.snapshots).toHaveLength(2)
    // First call: just the user prompt + the tool defs were offered.
    expect(provider.snapshots[0].messageCount).toBe(1)
    expect(provider.snapshots[0].toolNames).toContain('read_context')
    // Second call: the loop fed back assistant(tool_use) + tool(result) BEFORE re-invoking the model.
    expect(provider.snapshots[1].messageCount).toBe(3)
    const toolMsg = provider.snapshots[1].messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.results[0]).toMatchObject({ name: 'read_context', ok: true })
    expect(toolMsg.results[0].content).toContain('build it')

    expect(result.receipt.toolCallCount).toBe(1)
    expect(result.receipt.stopReason).toBe('final-answer')
    expect(result.receipt.validation.passed).toBe(true)
    expect(result.chat.content).toContain('APPROVED')
  })

  it('refuses a tool that is not in the allowlist and hands the model a recoverable error', async () => {
    const provider = scripted([
      { textContent: '', toolCalls: [{ id: 't1', name: 'delete_everything', input: {} }], stopReason: 'tool_use' },
      { textContent: 'ok, done differently', toolCalls: [], stopReason: 'stop' },
    ])
    const result = await runDirectLlmToolLoop({
      llm: llm(),
      options: toolLoopOptions(),
      node,
      instance,
      traceId: 'trace-2',
      toolContext: toolCtx(),
      callToolProvider: provider.fn,
    })

    expect(result.receipt.turns[0].toolCalls[0]).toMatchObject({ name: 'delete_everything', ok: false })
    const toolMsg = provider.snapshots[1].messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.results[0].content).toContain('not allowed')
    expect(result.receipt.stopReason).toBe('final-answer')
  })

  it('is bounded by the turn ceiling when the model never stops calling tools', async () => {
    const provider = recordingProvider(turn => ({
      textContent: 'still working',
      toolCalls: [{ id: `c${turn}`, name: 'read_context', input: { path: `vars.k${turn}` } }], // distinct each turn (dodges the no-progress guard)
      stopReason: 'tool_use',
    }))
    const result = await runDirectLlmToolLoop({
      llm: llm(),
      options: toolLoopOptions({ maxTurns: 3 }),
      node,
      instance,
      traceId: 'trace-3',
      toolContext: toolCtx(),
      callToolProvider: provider.fn,
    })

    expect(provider.snapshots).toHaveLength(3)
    expect(result.receipt.turns).toHaveLength(3)
    expect(result.receipt.stopReason).toBe('max-turns')
    expect(result.receipt.warnings.some(w => w.includes('ceiling'))).toBe(true)
  })

  it('stops early when the model repeats the same tool call with no progress', async () => {
    const provider = recordingProvider(() => ({
      textContent: 'again',
      toolCalls: [{ id: 'x', name: 'read_context', input: { path: 'vars.story' } }], // identical every turn
      stopReason: 'tool_use',
    }))
    const result = await runDirectLlmToolLoop({
      llm: llm(),
      options: toolLoopOptions({ maxTurns: 8 }),
      node,
      instance,
      traceId: 'trace-4',
      toolContext: toolCtx(),
      callToolProvider: provider.fn,
    })

    expect(result.receipt.stopReason).toBe('no-progress')
    expect(result.receipt.turns.length).toBeLessThan(8)
    expect(result.receipt.warnings.some(w => w.includes('no progress'))).toBe(true)
  })

  it('lets the model self-check via validate_output before finalizing', async () => {
    const provider = scripted([
      { textContent: 'let me validate', toolCalls: [{ id: 'v1', name: 'validate_output', input: { candidate: 'no verdict here' } }], stopReason: 'tool_use' },
      { textContent: 'Final answer: APPROVED', toolCalls: [], stopReason: 'stop' },
    ])
    const result = await runDirectLlmToolLoop({
      llm: llm(),
      options: toolLoopOptions({ requiredOutputIncludes: ['APPROVED'] }),
      node,
      instance,
      traceId: 'trace-5',
      toolContext: toolCtx({ requiredOutputIncludes: ['APPROVED'] }),
      callToolProvider: provider.fn,
    })

    const toolMsg = provider.snapshots[1].messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.results[0].content).toContain('INVALID')
    expect(toolMsg.results[0].content).toContain('missing required output text: APPROVED')
    expect(result.receipt.validation.passed).toBe(true)
    expect(result.chat.content).toContain('APPROVED')
  })

  it('throws on hard validation when the final answer misses the contract', async () => {
    await expect(runDirectLlmToolLoop({
      llm: llm(),
      options: toolLoopOptions({ requiredOutputIncludes: ['APPROVED'], validationMode: 'hard' }),
      node,
      instance,
      traceId: 'trace-6',
      toolContext: toolCtx({ requiredOutputIncludes: ['APPROVED'] }),
      callToolProvider: async () => ({ textContent: 'no verdict', toolCalls: [], stopReason: 'stop' }),
    })).rejects.toMatchObject({
      name: 'DirectLlmToolLoopError',
      code: 'DIRECT_LLM_TOOL_LOOP_VALIDATION_FAILED',
    })
  })
})

describe('direct LLM tool registry', () => {
  it('resolves the safe default set and drops unknown tool names', () => {
    expect(resolveDirectLlmTools(null).tools.map(t => t.name).sort()).toEqual(['list_context_keys', 'read_context', 'validate_output'])
    const { tools, unknown } = resolveDirectLlmTools(['read_context', 'nope'])
    expect(tools.map(t => t.name)).toEqual(['read_context'])
    expect(unknown).toEqual(['nope'])
  })

  it('never dispatches a tool outside the enabled allowlist', () => {
    const { tools } = resolveDirectLlmTools(['read_context'])
    const denied = dispatchDirectLlmTool('validate_output', { candidate: 'x' }, tools, toolCtx())
    expect(denied.ok).toBe(false)
    expect(denied.content).toContain('not allowed')
  })

  it('read_context reads instance context by dotted path (and reports misses)', () => {
    const ctx = toolCtx()
    expect(DIRECT_LLM_TOOL_REGISTRY.read_context.run({ path: 'vars.story' }, ctx)).toMatchObject({ ok: true })
    expect(DIRECT_LLM_TOOL_REGISTRY.read_context.run({ path: 'vars.story' }, ctx).content).toContain('build it')
    expect(DIRECT_LLM_TOOL_REGISTRY.read_context.run({ path: 'vars.missing' }, ctx).ok).toBe(false)
  })

  it('list_context_keys enumerates the available buckets', () => {
    const out = DIRECT_LLM_TOOL_REGISTRY.list_context_keys.run({}, toolCtx())
    expect(out.content).toContain('vars.*')
    expect(out.content).toContain('story')
  })

  it('validateAgainstContract enforces required text and JSON schema', () => {
    expect(validateAgainstContract('has APPROVED', { requiredOutputIncludes: ['APPROVED'], validationMode: 'soft' }).passed).toBe(true)
    expect(validateAgainstContract('nope', { requiredOutputIncludes: ['APPROVED'], validationMode: 'soft' }).passed).toBe(false)
    expect(validateAgainstContract('anything', { requiredOutputIncludes: ['APPROVED'], validationMode: 'off' }).passed).toBe(true)
  })
})

describe('direct LLM tool provider conversions', () => {
  const convo: LoopMessage[] = [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'ok', toolCalls: [{ id: 't1', name: 'read_context', input: { path: 'vars.story' } }] },
    { role: 'tool', results: [{ id: 't1', name: 'read_context', content: 'build it', ok: true }] },
  ]

  it('converts the conversation to Anthropic tool_use / tool_result blocks', () => {
    const a = toAnthropicMessages(convo) as any[]
    expect(a[1].content).toContainEqual({ type: 'tool_use', id: 't1', name: 'read_context', input: { path: 'vars.story' } })
    expect(a[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', content: 'build it' })
    const withError = toAnthropicMessages([{ role: 'tool', results: [{ id: 't2', name: 'x', content: 'bad', ok: false }] }]) as any[]
    expect(withError[0].content[0].is_error).toBe(true)
  })

  it('converts the conversation to OpenAI tool_calls / role:tool messages', () => {
    const o = toOpenAiMessages('sys', convo) as any[]
    expect(o[0]).toMatchObject({ role: 'system', content: 'sys' })
    expect(o[2].tool_calls[0]).toMatchObject({ id: 't1', type: 'function', function: { name: 'read_context' } })
    expect(o[2].tool_calls[0].function.arguments).toBe(JSON.stringify({ path: 'vars.story' }))
    expect(o[3]).toMatchObject({ role: 'tool', tool_call_id: 't1', content: 'build it' })
  })

  it('parses an Anthropic tool_use response', () => {
    const parsed = parseAnthropicToolResponse({
      content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'u1', name: 'read_context', input: { path: 'a' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 4 },
      id: 'msg_1',
    })
    expect(parsed.textContent).toBe('hello')
    expect(parsed.toolCalls).toEqual([{ id: 'u1', name: 'read_context', input: { path: 'a' } }])
    expect(parsed.totalTokens).toBe(7)
    expect(parsed.providerRequestId).toBe('msg_1')
  })

  it('parses an OpenAI tool_calls response (arguments are a JSON string)', () => {
    const parsed = parseOpenAiToolResponse({
      choices: [{ message: { content: 'hey', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_context', arguments: '{"path":"a"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 },
      id: 'cmpl_1',
    })
    expect(parsed.textContent).toBe('hey')
    expect(parsed.toolCalls).toEqual([{ id: 'c1', name: 'read_context', input: { path: 'a' } }])
    expect(parsed.providerRequestId).toBe('cmpl_1')
  })
})
