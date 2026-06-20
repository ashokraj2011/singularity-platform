import { describe, expect, it } from 'vitest'
import { agentRunCorrelationUpdate, mergeAgentRunCorrelation } from '../src/lib/agent-run-correlation'

describe('agentRunCorrelationUpdate', () => {
  it('extracts first-class run correlation fields from flat payloads', () => {
    expect(agentRunCorrelationUpdate({
      traceId: 'trace-1',
      cfCallId: 'cf-1',
      promptAssemblyId: 'pa-1',
      mcpServerId: 'mcp-1',
      mcpInvocationId: 'mcp-invoke-1',
      contextPackageId: 'ctx-1',
      modelCallId: 'model-1',
      laptopInvocationId: 'laptop-1',
    })).toMatchObject({
      traceId: 'trace-1',
      cfCallId: 'cf-1',
      promptAssemblyId: 'pa-1',
      mcpServerId: 'mcp-1',
      mcpInvocationId: 'mcp-invoke-1',
      contextPackageId: 'ctx-1',
      modelCallId: 'model-1',
      laptopInvocationId: 'laptop-1',
    })
  })

  it('falls back to nested correlation and first llm call id', () => {
    expect(agentRunCorrelationUpdate({
      correlation: {
        traceId: 'trace-nested',
        cfCallId: 'cf-nested',
        promptAssemblyId: 'pa-nested',
        llmCallIds: ['model-from-array'],
      },
    })).toMatchObject({
      traceId: 'trace-nested',
      cfCallId: 'cf-nested',
      promptAssemblyId: 'pa-nested',
      modelCallId: 'model-from-array',
    })
  })

  it('lets explicit update data override extracted values', () => {
    expect(mergeAgentRunCorrelation({ status: 'FAILED' }, {
      status: 'RUNNING',
      cfCallId: 'cf-override-test',
    })).toMatchObject({
      status: 'FAILED',
      cfCallId: 'cf-override-test',
    })
  })
})
