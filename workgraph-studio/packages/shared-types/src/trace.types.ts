export interface TraceContractIds {
  /**
   * Cross-service evidence spine. This id joins Workgraph, Prompt Composer,
   * Context Fabric, MCP, LLM Gateway, and audit-governance records.
   */
  traceId: string
  /** Workflow run identity. Do not use as a traceId substitute. */
  workflowInstanceId?: string
  promptAssemblyId?: string
  cfCallId?: string
  mcpInvocationId?: string
  agentRunId?: string
}

export type TraceScopedPayload<T extends Record<string, unknown> = Record<string, unknown>> = T & TraceContractIds
