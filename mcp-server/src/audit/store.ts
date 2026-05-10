/**
 * In-memory audit store (M7 v0).
 *
 * Holds recent LLM calls + tool invocations + artifacts so the MCP
 * `resources/read` endpoint can serve them. v0 is a simple ring buffer per
 * type — no durability. M9 wires this to a Postgres-backed log when the
 * WebSocket bridge lands.
 *
 * Correlation set follows the PLAN_mcp.md taxonomy:
 *   traceId, runId, runStepId, workItemId, agentId, toolInvocationId, artifactId
 */
import { v4 as uuidv4 } from "uuid";

export interface CorrelationIds {
  traceId?: string;
  runId?: string;
  runStepId?: string;
  workItemId?: string;
  agentId?: string;
  capabilityId?: string;
  mcpInvocationId: string;
}

export interface LlmCallRecord {
  id: string;
  correlation: CorrelationIds;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  prompt_messages_count: number;
  finish_reason: "stop" | "tool_call" | "length" | "error";
  error?: string;
  timestamp: string;
}

export interface ToolInvocationRecord {
  id: string;
  correlation: CorrelationIds;
  tool_name: string;
  args: Record<string, unknown>;
  output: unknown;
  success: boolean;
  error?: string;
  latency_ms: number;
  timestamp: string;
}

export interface ArtifactRecord {
  id: string;
  correlation: CorrelationIds;
  artifact_type: "TEXT" | "JSON" | "CODE_PATCH" | "CODE_DIFF" | "GIT_COMMIT";
  label?: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

const RING_CAP = 1000;
class Ring<T extends { id: string }> {
  private buf: T[] = [];
  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > RING_CAP) this.buf.splice(0, this.buf.length - RING_CAP);
  }
  byId(id: string): T | undefined {
    return this.buf.find((x) => x.id === id);
  }
  byTraceId(traceId: string): T[] {
    return this.buf.filter((x) => (x as unknown as { correlation: CorrelationIds }).correlation.traceId === traceId);
  }
  recent(limit = 50): T[] {
    return this.buf.slice(-limit).reverse();
  }
}

const llmCalls = new Ring<LlmCallRecord>();
const toolInvocations = new Ring<ToolInvocationRecord>();
const artifacts = new Ring<ArtifactRecord>();

export function recordLlmCall(r: Omit<LlmCallRecord, "id" | "timestamp">): LlmCallRecord {
  const rec: LlmCallRecord = { ...r, id: uuidv4(), timestamp: new Date().toISOString() };
  llmCalls.push(rec);
  return rec;
}
export function recordToolInvocation(
  r: Omit<ToolInvocationRecord, "id" | "timestamp">,
): ToolInvocationRecord {
  const rec: ToolInvocationRecord = { ...r, id: uuidv4(), timestamp: new Date().toISOString() };
  toolInvocations.push(rec);
  return rec;
}
export function recordArtifact(r: Omit<ArtifactRecord, "id" | "timestamp">): ArtifactRecord {
  const rec: ArtifactRecord = { ...r, id: uuidv4(), timestamp: new Date().toISOString() };
  artifacts.push(rec);
  return rec;
}

export const audit = {
  llmCalls: {
    byId: (id: string) => llmCalls.byId(id),
    byTraceId: (t: string) => llmCalls.byTraceId(t),
    recent: (limit?: number) => llmCalls.recent(limit),
  },
  toolInvocations: {
    byId: (id: string) => toolInvocations.byId(id),
    byTraceId: (t: string) => toolInvocations.byTraceId(t),
    recent: (limit?: number) => toolInvocations.recent(limit),
  },
  artifacts: {
    byId: (id: string) => artifacts.byId(id),
    byTraceId: (t: string) => artifacts.byTraceId(t),
    recent: (limit?: number) => artifacts.recent(limit),
  },
};
