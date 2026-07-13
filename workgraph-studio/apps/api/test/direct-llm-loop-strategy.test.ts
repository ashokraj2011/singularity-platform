import { describe, expect, it } from 'vitest'
import { validateDirectLlmConfig } from '../src/modules/workflow/runtime/executors/direct-llm-config'
import { validateLoopStrategyDefinition } from '../src/modules/workflow/loop-strategy.service'

describe('Direct LLM configuration validation', () => {
  it('normalizes a structured node and generates hard output validation by default', () => {
    const result = validateDirectLlmConfig({
      directLlm: {
        promptSource: 'INLINE',
        task: 'Classify the supplied document.',
        inputBindings: [{ name: 'document', path: 'vars.document', required: true }],
        outputContract: {
          fields: {
            verdict: { type: 'string', enum: ['APPROVE', 'REJECT'] },
            confidence: { type: 'number', required: true },
          },
        },
      },
    })
    expect(result.ok).toBe(true)
    expect(result.config.outputContract.validationMode).toBe('hard')
    expect(result.config.outputContract.jsonSchema).toMatchObject({ type: 'object' })
  })

  it('rejects malformed JSON, invalid paths, and enum values with field errors', () => {
    const result = validateDirectLlmConfig({
      task: 'Return structured output.',
      inputVariables: '{bad-json',
      outputFields: { verdict: { type: 'boolean', enum: ['APPROVE'] } },
      inputDocumentsPath: 'vars..documents',
    })
    expect(result.ok).toBe(false)
    expect(result.failures.map(item => item.field)).toEqual(expect.arrayContaining([
      'inputBindings',
      'outputContract.fields.verdict.enum',
      'inputDocumentsPath',
    ]))
  })

  it('requires the correct prompt source and rejects credential-bearing URLs', () => {
    const agent = validateDirectLlmConfig({ directLlm: { promptSource: 'AGENT_PROFILE' } })
    expect(agent.ok).toBe(false)
    expect(agent.failures.some(item => item.field === 'promptSource')).toBe(true)

    const url = validateDirectLlmConfig({ directLlm: { promptSource: 'URL', promptUrl: 'https://user:pass@example.com/prompt.md' } })
    expect(url.ok).toBe(false)
    expect(url.failures.some(item => item.field === 'promptUrl')).toBe(true)
  })

  it('rejects structurally inconsistent schemas and invalid validation modes', () => {
    const result = validateDirectLlmConfig({
      directLlm: {
        promptSource: 'INLINE',
        task: 'Return a decision.',
        outputContract: {
          validationMode: 'sometimes',
          jsonSchema: {
            type: 'object',
            properties: { score: { type: 'number', enum: ['high'], minimum: Number.POSITIVE_INFINITY } },
            required: ['score', 'missing'],
          },
        },
      },
    })
    expect(result.ok).toBe(false)
    expect(result.failures.map(item => item.field)).toEqual(expect.arrayContaining([
      'outputContract.validationMode',
      'outputContract.jsonSchema.required',
      'outputContract.jsonSchema.properties.score.enum',
      'outputContract.jsonSchema.properties.score.minimum',
    ]))
  })
})

describe('Loop strategy validation', () => {
  it('normalizes a bounded phase strategy and estimates its call budget', () => {
    const result = validateLoopStrategyDefinition({
      kind: 'PHASE',
      phaseOrder: ['PLAN', 'VERIFY'],
      maxTurns: 5,
      earlyStop: true,
      validationFailure: 'REPAIR',
      maxRepairAttempts: 2,
    })
    expect(result.ok).toBe(true)
    expect(result.definition.phaseOrder).toEqual(['PLAN', 'VERIFY'])
    expect(result.estimatedProviderCalls).toBe(4)
  })

  it('rejects unknown phases, duplicate phases, unsafe tools, and unbounded values', () => {
    const result = validateLoopStrategyDefinition({
      kind: 'TOOL',
      phaseOrder: ['PLAN', 'PLAN', 'NOT_A_PHASE'],
      tools: ['read_context', 'shell_exec'],
      maxTurns: 99,
      maxRepairAttempts: 7,
    })
    expect(result.ok).toBe(false)
    expect(result.failures.map(item => item.field)).toEqual(expect.arrayContaining([
      'phaseOrder', 'tools', 'maxTurns', 'maxRepairAttempts',
    ]))
  })
})
