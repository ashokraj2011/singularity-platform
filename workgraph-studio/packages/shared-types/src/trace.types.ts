export interface TraceContractIds {
  /**
   * Cross-service evidence spine. This id joins Workgraph, Prompt Composer,
   * Context Fabric, MCP, LLM Gateway, and audit-governance records.
   */
  traceId: string
  /** Workflow run identity. Do not use as a traceId substitute. */
  workflowInstanceId?: string
  workflowNodeId?: string
  workItemId?: string
  promptAssemblyId?: string
  cfCallId?: string
  mcpInvocationId?: string
  modelCallId?: string
  agentRunId?: string
  tenantId?: string
  userId?: string
  otelTraceId?: string
}

export interface TraceContext {
  traceId: string
  workflowInstanceId?: string
  workflowNodeId?: string
  agentRunId?: string
  workItemId?: string
  tenantId?: string
  userId?: string
}

export interface TraceCorrelation {
  traceId: string
  cfCallId?: string
  promptAssemblyId?: string
  mcpInvocationId?: string
  modelCallId?: string
  agentRunId?: string
  workflowInstanceId?: string
  workflowNodeId?: string
  workItemId?: string
  tenantId?: string
  userId?: string
  otelTraceId?: string
}

export type TraceScopedPayload<T extends Record<string, unknown> = Record<string, unknown>> = T & TraceContractIds

export const SINGULARITY_TRACE_HEADER = 'x-singularity-trace-id'
export const TRACE_ID_MAX_LENGTH = 300

export function normalizeTraceId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const traceId = value.trim()
  if (!traceId) return null
  if (traceId.length > TRACE_ID_MAX_LENGTH) return null
  if (traceId.includes('\0')) return null
  return traceId
}

export function requireTraceId(value: unknown, label = 'traceId'): string {
  const traceId = normalizeTraceId(value)
  if (!traceId) throw new Error(`${label} is required`)
  return traceId
}

export function traceHeaders(
  existing: Record<string, string> = {},
  traceId?: unknown,
): Record<string, string> {
  const headers = { ...existing }
  const normalized = normalizeTraceId(traceId)
  if (normalized) headers[SINGULARITY_TRACE_HEADER] = normalized
  return headers
}

export function traceIdFromParts(parts: unknown[], separator = '-'): string {
  const normalized = parts.map((part, index) => {
    const value = typeof part === 'number' || typeof part === 'bigint' ? String(part) : part
    return requireTraceId(value, `traceId part ${index + 1}`)
  })
  return requireTraceId(normalized.join(separator), 'traceId')
}

export function workflowNodeTraceId(input: {
  prefix?: string
  workflowInstanceId: unknown
  workflowNodeId: unknown
  runId?: unknown
}): string {
  const prefix = normalizeTraceId(input.prefix) ?? 'wf'
  const workflowInstanceId = requireTraceId(input.workflowInstanceId, 'workflowInstanceId')
  const workflowNodeId = requireTraceId(input.workflowNodeId, 'workflowNodeId')
  const runId = normalizeTraceId(input.runId)
  return traceIdFromParts([
    prefix,
    workflowInstanceId,
    workflowNodeId,
    ...(runId ? [runId.slice(0, 8)] : []),
  ])
}
