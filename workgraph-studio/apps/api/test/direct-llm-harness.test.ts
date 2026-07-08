import { describe, expect, it } from 'vitest'
import {
  DirectLlmHarnessError,
  runDirectLlmHarness,
  type DirectLlmHarnessOptions,
  type DirectLlmProviderRequest,
} from '../src/modules/workflow/runtime/executors/DirectLlmHarness'

const node = {
  id: 'node-1',
  label: 'Direct LLM',
  nodeType: 'DIRECT_LLM_TASK',
  config: {},
} as any

const instance = {
  id: 'inst-1',
  templateId: 'tpl-1',
  createdById: 'user-1',
  tenantId: 'tenant-1',
  context: { vars: { story: 'build it' }, globals: { capability: 'cap-1' } },
} as any

const llm: DirectLlmProviderRequest = {
  provider: 'mock',
  model: 'mock-direct',
  modelAlias: 'mock',
  prompt: 'Create a concise implementation plan.',
  systemPrompt: 'You are careful.',
  maxTokens: 800,
  timeoutMs: 60_000,
  temperature: 0.2,
}

function options(overrides: Partial<DirectLlmHarnessOptions> = {}): DirectLlmHarnessOptions {
  return {
    enabled: true,
    composeWithPromptComposer: false,
    loopEnabled: false,
    loopStageKey: 'loop.stage',
    loopPhases: [],
    maxTurns: 1,
    requiredOutputIncludes: [],
    validationMode: 'soft',
    ...overrides,
  }
}

describe('direct LLM harness', () => {
  it('uses prompt-composer preview output before making the direct provider call', async () => {
    const seenPrompts: string[] = []
    const result = await runDirectLlmHarness({
      llm,
      options: options({
        composeWithPromptComposer: true,
        agentTemplateId: '00000000-0000-0000-0000-000000000001',
      }),
      node,
      instance,
      traceId: 'trace-1',
      composePrompt: async () => ({
        promptAssemblyId: 'assembly-1',
        promptHash: 'hash-1',
        estimatedInputTokens: 12,
        layersUsed: [],
        warnings: ['preview warning'],
        assembled: { systemPrompt: 'assembled system', message: 'assembled message' },
      }),
      callProvider: async request => {
        seenPrompts.push(request.prompt)
        expect(request.systemPrompt).toContain('assembled system')
        return { content: 'assembled answer', inputTokens: 10, outputTokens: 5, totalTokens: 15, providerRequestId: 'req-1' }
      },
    })

    expect(seenPrompts).toEqual(['assembled message'])
    expect(result.receipt.promptSource).toBe('prompt-composer-preview')
    expect(result.receipt.promptAssemblyId).toBe('assembly-1')
    expect(result.receipt.warnings).toContain('prompt-composer: preview warning')
  })

  it('runs a bounded phase loop using prompt-composer stage prompts', async () => {
    const phases: string[] = []
    const result = await runDirectLlmHarness({
      llm,
      options: options({
        loopEnabled: true,
        loopPhases: ['PLAN', 'SELF_REVIEW'],
        maxTurns: 2,
      }),
      node,
      instance,
      traceId: 'trace-2',
      resolveStagePrompt: async ({ phase }) => ({
        task: `stage task ${phase}`,
        systemPromptAppend: `system ${phase}`,
        extraContext: `extra ${phase}`,
        promptProfileId: `profile-${phase}`,
        bindingId: `binding-${phase}`,
        stageKey: 'loop.stage',
        agentRole: null,
        phase,
      }),
      callProvider: async request => {
        const phase = request.prompt.startsWith('stage task PLAN') ? 'PLAN' : 'SELF_REVIEW'
        phases.push(phase)
        expect(request.prompt).toContain(`stage task ${phase}`)
        expect(request.systemPrompt).toContain(`system ${phase}`)
        return { content: `output ${phase}`, inputTokens: 3, outputTokens: 4, totalTokens: 7, providerRequestId: `req-${phase}` }
      },
    })

    expect(phases).toEqual(['PLAN', 'SELF_REVIEW'])
    expect(result.chat.content).toBe('output SELF_REVIEW')
    expect(result.chat.totalTokens).toBe(14)
    expect(result.receipt.mode).toBe('loop')
    expect(result.receipt.phaseProtocol).toBe('context-fabric-governed-loop-compatible')
    expect(result.receipt.turns.map(turn => turn.phase)).toEqual(['PLAN', 'SELF_REVIEW'])
  })

  it('fails hard when configured output validation does not pass', async () => {
    await expect(runDirectLlmHarness({
      llm,
      options: options({
        requiredOutputIncludes: ['APPROVED'],
        validationMode: 'hard',
      }),
      node,
      instance,
      traceId: 'trace-3',
      callProvider: async () => ({ content: 'needs more work', providerRequestId: 'req-3' }),
    })).rejects.toMatchObject({
      name: 'DirectLlmHarnessError',
      code: 'DIRECT_LLM_HARNESS_VALIDATION_FAILED',
    } satisfies Partial<DirectLlmHarnessError>)
  })
})
