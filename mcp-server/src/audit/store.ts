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

// M13 — Code-change observability. Produced by the provenanceExtractor when
// a tool invocation either returns a structured `kind:"code_change"` envelope
// or matches the heuristic file-touching name list. Lives in its own ring so
// the resources/code-changes endpoint can answer in O(n) without scanning
// generic artifacts. The originating ToolInvocationRecord is referenced via
// correlation.toolInvocationId set from the parent invocation.
export interface CodeChangeRecord {
  id: string;
  correlation: CorrelationIds & { toolInvocationId?: string };
  /** Files (relative paths) the tool reported touching. */
  paths_touched: string[];
  /** Optional unified diff (one or more files). */
  diff?: string;
  /** Optional patch (apply-patch style envelope). */
  patch?: string;
  /** Optional git commit SHA when the change was committed. */
  commit_sha?: string;
  /** Optional language hint (eg "typescript", "python"). */
  language?: string;
  lines_added?: number;
  lines_removed?: number;
  /** Tool that produced the change (denormalised for quick UI display). */
  tool_name: string;
  /** Free-form notes from the extractor — eg "envelope" / "heuristic" / "git-commit-only". */
  source: "envelope" | "heuristic";
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
const codeChanges = new Ring<CodeChangeRecord>();

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
export function recordCodeChange(r: Omit<CodeChangeRecord, "id" | "timestamp">): CodeChangeRecord {
  const rec: CodeChangeRecord = { ...r, id: `cc_${uuidv4()}`, timestamp: new Date().toISOString() };
  codeChanges.push(rec);
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
  codeChanges: {
    byId: (id: string) => codeChanges.byId(id),
    byTraceId: (t: string) => codeChanges.byTraceId(t),
    recent: (limit?: number) => codeChanges.recent(limit),
  },
};
