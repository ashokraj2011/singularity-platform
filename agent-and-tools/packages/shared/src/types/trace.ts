export interface TraceContractIds {
  /**
   * Cross-service evidence spine. This id must be stable across Workgraph,
   * Prompt Composer, Context Fabric, MCP, LLM Gateway, and audit-governance
   * records for one execution path.
   */
  traceId: string;
  /** Workflow run identity. Never substitute this for traceId when traceId exists. */
  workflowInstanceId?: string;
  /** Prompt Composer receipt id. */
  promptAssemblyId?: string;
  /** Context Fabric call id. */
  cfCallId?: string;
  /** MCP invocation id. */
  mcpInvocationId?: string;
  /** Agent runtime/run id when present. */
  agentRunId?: string;
}

export type TraceScopedPayload<T extends Record<string, unknown> = Record<string, unknown>> = T & TraceContractIds;
