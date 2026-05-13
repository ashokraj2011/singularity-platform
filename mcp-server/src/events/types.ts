/**
 * Event family taxonomy (PLAN_mcp.md §5).
 *
 * Every event flowing across the WebSocket bridge or persisted in the
 * replay ring carries:
 *   - kind        — one of the families below
 *   - id          — uuid for replay-since coordination
 *   - timestamp   — ISO-8601
 *   - correlation — full set so consumers can join across systems
 *   - payload     — kind-specific
 */

export type EventKind =
  | "llm.request"
  | "llm.response"
  | "llm.stream.delta"
  | "tool.invocation.created"
  | "tool.invocation.updated"
  | "artifact.created"
  | "artifact.updated"
  | "approval.wait.created"
  | "approval.wait.resolved"
  | "code_change.detected"
  | "workspace.branch.created"
  | "workspace.ast.indexed"
  | "workspace.ast.updated"
  | "git.session.updated"
  | "git.commit.created"
  | "run.event";

export interface EventCorrelation {
  traceId?: string;
  runId?: string;
  runStepId?: string;
  workItemId?: string;
  workflowInstanceId?: string;
  nodeId?: string;
  agentId?: string;
  capabilityId?: string;
  tenantId?: string;
  mcpInvocationId?: string;
  toolInvocationId?: string;
  artifactId?: string;
  llmCallId?: string;
}

export interface McpEventEnvelope {
  id: string;
  kind: EventKind;
  timestamp: string;
  correlation: EventCorrelation;
  severity?: "info" | "warn" | "error";
  payload: Record<string, unknown>;
}

export interface SubscriptionFilter {
  trace_id?: string;
  run_id?: string;
  capability_id?: string;
  tenant_id?: string;
  agent_id?: string;
  tool_invocation_id?: string;
  artifact_id?: string;
  kinds?: EventKind[];
  severities?: ("info" | "warn" | "error")[];
}

export function matchesFilter(ev: McpEventEnvelope, f: SubscriptionFilter | undefined): boolean {
  if (!f) return true;
  if (f.trace_id && ev.correlation.traceId !== f.trace_id) return false;
  if (f.run_id && ev.correlation.runId !== f.run_id) return false;
  if (f.capability_id && ev.correlation.capabilityId !== f.capability_id) return false;
  if (f.tenant_id && ev.correlation.tenantId !== f.tenant_id) return false;
  if (f.agent_id && ev.correlation.agentId !== f.agent_id) return false;
  if (f.tool_invocation_id && ev.correlation.toolInvocationId !== f.tool_invocation_id) return false;
  if (f.artifact_id && ev.correlation.artifactId !== f.artifact_id) return false;
  if (f.kinds && f.kinds.length > 0 && !f.kinds.includes(ev.kind)) return false;
  if (f.severities && f.severities.length > 0) {
    const sev = ev.severity ?? "info";
    if (!f.severities.includes(sev)) return false;
  }
  return true;
}
