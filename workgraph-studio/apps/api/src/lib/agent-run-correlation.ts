import type { Prisma } from '@prisma/client'

type CorrelationSource = Record<string, unknown> | null | undefined

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstString(values: unknown): string | undefined {
  if (!Array.isArray(values)) return undefined
  for (const value of values) {
    const parsed = stringValue(value)
    if (parsed) return parsed
  }
  return undefined
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function agentRunCorrelationUpdate(source: CorrelationSource): Prisma.AgentRunUpdateInput {
  const correlation = nestedRecord(source?.correlation) ?? {}
  const get = (...keys: string[]) => {
    for (const key of keys) {
      const direct = stringValue(source?.[key])
      if (direct) return direct
      const nested = stringValue(correlation[key])
      if (nested) return nested
    }
    return undefined
  }
  const data: Prisma.AgentRunUpdateInput = {}
  const traceId = get('traceId', 'trace_id')
  const cfCallId = get('cfCallId', 'cf_call_id')
  const promptAssemblyId = get('promptAssemblyId', 'prompt_assembly_id')
  const mcpServerId = get('mcpServerId', 'mcp_server_id')
  const mcpInvocationId = get('mcpInvocationId', 'mcp_invocation_id')
  const contextPackageId = get('contextPackageId', 'context_package_id')
  const modelCallId = get('modelCallId', 'model_call_id') ?? firstString(source?.llmCallIds) ?? firstString(correlation.llmCallIds)
  const laptopInvocationId = get('laptopInvocationId', 'laptop_invocation_id')

  if (traceId) data.traceId = traceId
  if (cfCallId) data.cfCallId = cfCallId
  if (promptAssemblyId) data.promptAssemblyId = promptAssemblyId
  if (mcpServerId) data.mcpServerId = mcpServerId
  if (mcpInvocationId) data.mcpInvocationId = mcpInvocationId
  if (contextPackageId) data.contextPackageId = contextPackageId
  if (modelCallId) data.modelCallId = modelCallId
  if (laptopInvocationId) data.laptopInvocationId = laptopInvocationId
  return data
}

export function mergeAgentRunCorrelation(
  data: Prisma.AgentRunUpdateInput,
  source: CorrelationSource,
): Prisma.AgentRunUpdateInput {
  return { ...agentRunCorrelationUpdate(source), ...data }
}
