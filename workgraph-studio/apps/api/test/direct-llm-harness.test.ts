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

// Every harness prompt carries a `Direct LLM harness phase: <PHASE>.` marker (see phasePrompt).
function phaseOf(prompt: string): string {
  return prompt.match(/Direct LLM harness phase: (\w+)\./)?.[1] ?? 'UNKNOWN'
}

// Minimal stage response so tests never reach the network-backed default resolver.
const stageFor = (phase: string) => ({
  task: `stage ${phase}`,
  systemPromptAppend: '',
  extraContext: '',
  promptProfileId: `profile-${phase}`,
  bindingId: `binding-${phase}`,
  stageKey: 'loop.stage',
  agentRole: null,
  phase,
}) as any

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

  it('passes event document artifacts to prompt-composer preview', async () => {
    const result = await runDirectLlmHarness({
      llm,
      options: options({
        composeWithPromptComposer: true,
        agentTemplateId: '00000000-0000-0000-0000-000000000001',
        artifacts: [{ label: 'Event design doc', role: 'REFERENCE', content: '# Design\nValidate this.' }],
      }),
      node,
      instance,
      traceId: 'trace-artifact',
      composePrompt: async ({ options: incomingOptions }) => {
        expect(incomingOptions.artifacts).toEqual([{ label: 'Event design doc', role: 'REFERENCE', content: '# Design\nValidate this.' }])
        return {
          promptAssemblyId: 'assembly-artifact',
          promptHash: 'hash-artifact',
          estimatedInputTokens: 20,
          layersUsed: [],
          warnings: [],
          assembled: { systemPrompt: '', message: 'assembled with artifact' },
        }
      },
      callProvider: async request => ({ content: request.prompt, providerRequestId: 'req-artifact' }),
    })

    expect(result.chat.content).toBe('assembled with artifact')
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

  it('validates a structured object even when the provider wraps it in prose', async () => {
    const result = await runDirectLlmHarness({
      llm,
      options: options({
        outputJsonSchema: {
          type: 'object',
          required: ['verdict'],
          properties: { verdict: { type: 'string', enum: ['APPROVE', 'REJECT'] } },
        },
        validationMode: 'hard',
      }),
      node,
      instance,
      traceId: 'trace-json',
      callProvider: async () => ({
        content: 'Verifier result:\n{"verdict":"APPROVE"}',
        providerRequestId: 'req-json',
      }),
    })

    expect(result.receipt.validation.passed).toBe(true)
  })

  it('early-stops the loop once the output contract is satisfied at a review phase', async () => {
    const seen: string[] = []
    const result = await runDirectLlmHarness({
      llm,
      options: options({
        loopEnabled: true,
        loopPhases: ['PLAN', 'EXPLORE', 'SELF_REVIEW', 'FINALIZE'],
        maxTurns: 4,
        requiredOutputIncludes: ['APPROVED'],
        validationMode: 'soft',
      }),
      node,
      instance,
      traceId: 'trace-earlystop',
      resolveStagePrompt: async ({ phase }) => stageFor(phase),
      callProvider: async request => {
        const phase = phaseOf(request.prompt)
        seen.push(phase)
        // Contract ('APPROVED') is only met at SELF_REVIEW; earlier phases stay unconverged.
        return { content: phase === 'SELF_REVIEW' ? 'verdict: APPROVED' : `working on ${phase}`, providerRequestId: `req-${phase}` }
      },
    })

    expect(seen).toEqual(['PLAN', 'EXPLORE', 'SELF_REVIEW']) // FINALIZE skipped
    expect(result.receipt.stopReason).toBe('converged')
    expect(result.receipt.validation.passed).toBe(true)
    expect(result.receipt.repairAttempts).toBe(0)
    expect(result.receipt.warnings.some(warning => warning.includes('early-stop'))).toBe(true)
  })

  it('runs a bounded VERIFY→REPAIR loop and stops at maxRepairAttempts', async () => {
    const seen: string[] = []
    const result = await runDirectLlmHarness({
      llm,
      options: options({
        loopEnabled: true,
        loopPhases: ['PLAN', 'SELF_REVIEW'],
        maxTurns: 12,
        requiredOutputIncludes: ['APPROVED'],
        validationMode: 'soft',
        maxRepairAttempts: 3,
      }),
      node,
      instance,
      traceId: 'trace-repair',
      resolveStagePrompt: async ({ phase }) => stageFor(phase),
      callProvider: async request => {
        seen.push(phaseOf(request.prompt))
        return { content: 'still no verdict', providerRequestId: `req-${seen.length}` } // never satisfies the contract
      },
    })

    expect(seen).toEqual(['PLAN', 'SELF_REVIEW', 'REPAIR', 'REPAIR', 'REPAIR'])
    expect(result.receipt.turns.filter(turn => turn.phase === 'REPAIR')).toHaveLength(3)
    expect(seen.length).toBeLessThanOrEqual(12) // never exceeds the turn ceiling
    expect(result.receipt.stopReason).toBe('repair-exhausted')
    expect(result.reviewRequired).toBe(true) // soft mode, still failing
  })

  it('feeds the concrete validation errors and failing output into the REPAIR prompt', async () => {
    const repairPrompts: string[] = []
    await runDirectLlmHarness({
      llm,
      options: options({
        loopEnabled: true,
        loopPhases: ['SELF_REVIEW'],
        maxTurns: 4,
        requiredOutputIncludes: ['APPROVED'],
        validationMode: 'soft',
        maxRepairAttempts: 1,
      }),
      node,
      instance,
      traceId: 'trace-feedback',
      resolveStagePrompt: async ({ phase }) => stageFor(phase),
      callProvider: async request => {
        if (phaseOf(request.prompt) === 'REPAIR') repairPrompts.push(request.prompt)
        return { content: 'first draft, incomplete', providerRequestId: 'r' }
      },
    })

    expect(repairPrompts).toHaveLength(1)
    expect(repairPrompts[0]).toContain('missing required output text: APPROVED')
    expect(repairPrompts[0]).toContain('Previous output that failed validation:')
    expect(repairPrompts[0]).toContain('first draft, incomplete')
  })

  it('with no output contract, runs every planned phase once (no early-stop, no repair)', async () => {
    const seen: string[] = []
    const result = await runDirectLlmHarness({
      llm,
      options: options({
        loopEnabled: true,
        loopPhases: ['PLAN', 'VERIFY', 'SELF_REVIEW'],
        maxTurns: 5, // > phase count so a clean completion is not mislabeled as turn-cap
        validationMode: 'soft', // but no requiredOutputIncludes / schema → no contract to converge on
      }),
      node,
      instance,
      traceId: 'trace-nocontract',
      resolveStagePrompt: async ({ phase }) => stageFor(phase),
      callProvider: async request => {
        seen.push(phaseOf(request.prompt))
        return { content: 'ok', providerRequestId: 'r' }
      },
    })

    expect(seen).toEqual(['PLAN', 'VERIFY', 'SELF_REVIEW'])
    expect(result.receipt.turns.some(turn => turn.phase === 'REPAIR')).toBe(false)
    expect(result.receipt.stopReason).toBe('phases-exhausted')
    expect(result.receipt.repairAttempts).toBe(0)
  })
})
