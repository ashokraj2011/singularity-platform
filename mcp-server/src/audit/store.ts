/**
 * Local audit store.
 *
 * Holds recent LLM calls + tool invocations + artifacts so the MCP
 * `resources/read` endpoint can serve them. The hot read path remains a small
 * ring buffer, while a JSONL journal under the sandbox lets recent records
 * survive MCP restarts.
 *
 * Correlation set follows the PLAN_mcp.md taxonomy:
 *   traceId, runId, runStepId, workItemId, agentId, toolInvocationId, artifactId
 */
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config";

export interface CorrelationIds {
  traceId?: string;
  sessionId?: string;
  runId?: string;
  runStepId?: string;
  workItemId?: string;
  workItemCode?: string;
  workflowInstanceId?: string;
  nodeId?: string;
  agentId?: string;
  capabilityId?: string;
  tenantId?: string;
  mcpInvocationId: string;
}

export interface LlmCallRecord {
  id: string;
  correlation: CorrelationIds;
  model_alias?: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost?: number;
  latency_ms: number;
  prompt_messages_count: number;
  finish_reason: "stop" | "tool_call" | "length" | "error";
  error?: string;
  timestamp: string;
  // [trace] step index in the agent loop, so a transcript-style viewer can
  // group LLM calls + tool invocations into per-step blocks.
  step_index?: number;
  // [trace] phase name when the run is using the Phased Agent Reasoning
  // Model (v4). Omitted for flat-loop runs. Mirrors step_index in pattern —
  // bin/trace.sh can group consecutive same-phase calls into phase blocks.
  phase?: string;
  // [trace] compact preview of the prompt — the last N messages with
  // role + content excerpt — to let an operator inspect what context the
  // model saw without dumping the entire transcript into the JSONL.
  prompt_messages_preview?: Array<{
    role: string;
    content_preview: string;
    tool_call_id?: string;
    tool_name?: string;
  }>;
  // [trace] the model's textual response (truncated). For pure tool-call
  // responses this is usually empty/null; for completion turns it carries
  // the final user-visible text.
  response_text?: string;
  // [trace] the model's emitted tool calls. Captured as compact summary so
  // a trace viewer can show "what did the model decide to do this turn".
  response_tool_calls?: Array<{ name: string; args_preview: string }>;
}

export interface ToolInvocationRecord {
  id: string;
  correlation: CorrelationIds;
  tool_name: string;
  args: Record<string, unknown>;
  output: unknown;
  success: boolean;
  error?: string;
  error_code?: string;
  latency_ms: number;
  timestamp: string;
  // P0 #2 — brokered git credential provenance (issuanceId/provider/expiry/repo/
  // operation/actor). NEVER the token itself; the sha256 fingerprint lives on the
  // IAM issuance record (linked by issuanceId).
  gitCredentialMetadata?: Record<string, unknown>;
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
type AuditKind = "llm_call" | "tool_invocation" | "artifact" | "code_change";
type PersistedAuditRecord =
  | { kind: "llm_call"; record: LlmCallRecord }
  | { kind: "tool_invocation"; record: ToolInvocationRecord }
  | { kind: "artifact"; record: ArtifactRecord }
  | { kind: "code_change"; record: CodeChangeRecord };

function auditLogPath(): string {
  return config.MCP_AUDIT_LOG_PATH ?? path.join(config.MCP_SANDBOX_ROOT, ".singularity", "mcp-audit.jsonl");
}

/**
 * M65 Slice 1C — Local JSONL store is sandbox-debug ONLY.
 *
 * The canonical audit record for every llm_call / tool_invocation /
 * artifact / code_change lives in audit-governance-service. Each helper
 * below (recordLlmCall, recordToolInvocation, …) calls emitAuditEvent
 * to ship the structured event to audit-gov fire-and-forget AFTER it
 * writes to the in-memory ring + this JSONL file.
 *
 * This file:
 *   - is NOT retained across container recreates (it lives under
 *     $MCP_SANDBOX_ROOT/.singularity/ which is mounted from the
 *     workspace bind, not a named volume)
 *   - is NOT exported to any UI; the workbench Loop tab + the M63
 *     audit search both read from audit-gov, not from here
 *   - serves two purposes only:
 *     1. Hot reload of the in-memory ring after a process restart in
 *        sandbox mode (so resources/read can serve recent records
 *        immediately without re-querying audit-gov)
 *     2. Operator debugging via `cat mcp-audit.jsonl` when audit-gov is
 *        unavailable in a dev sandbox
 *
 * If you find yourself reading this file from another service, stop —
 * query audit-gov instead. M66 will likely delete this JSONL writer
 * once the agent-runtime / context-fabric / workbench paths are all
 * confirmed to use audit-gov as the canonical source.
 */
function persistAuditRecord(kind: AuditKind, record: unknown): void {
  const filePath = auditLogPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify({ kind, record })}\n`, "utf8");
  } catch {
    // Audit resources should not fail an agent run if the local journal is
    // unavailable. The in-memory ring still serves the current process,
    // and audit-gov has the canonical record regardless.
  }
}

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

function hydrateAuditJournal(): void {
  const filePath = auditLogPath();
  if (!fs.existsSync(filePath)) return;
  try {
    const lines = fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-config.MCP_AUDIT_RESTORE_LIMIT);
    for (const line of lines) {
      const entry = JSON.parse(line) as PersistedAuditRecord;
      if (entry.kind === "llm_call") llmCalls.push(entry.record);
      if (entry.kind === "tool_invocation") toolInvocations.push(entry.record);
      if (entry.kind === "artifact") artifacts.push(entry.record);
      if (entry.kind === "code_change") codeChanges.push(entry.record);
    }
  } catch {
    // M65 Slice 1C — Corrupt journal lines are ignored. audit-gov is the
    // authoritative store; this hydration just speeds up the first few
    // resources/read calls after a process restart. Missing/corrupt
    // entries mean the operator has to wait one tool call before the
    // ring repopulates from live events — non-fatal.
  }
}

hydrateAuditJournal();

export function recordLlmCall(r: Omit<LlmCallRecord, "id" | "timestamp">): LlmCallRecord {
  const rec: LlmCallRecord = { ...r, id: uuidv4(), timestamp: new Date().toISOString() };
  llmCalls.push(rec);
  persistAuditRecord("llm_call", rec);
  return rec;
}
export function recordToolInvocation(
  r: Omit<ToolInvocationRecord, "id" | "timestamp">,
): ToolInvocationRecord {
  const rec: ToolInvocationRecord = { ...r, id: uuidv4(), timestamp: new Date().toISOString() };
  toolInvocations.push(rec);
  persistAuditRecord("tool_invocation", rec);
  return rec;
}
export function recordArtifact(r: Omit<ArtifactRecord, "id" | "timestamp">): ArtifactRecord {
  const rec: ArtifactRecord = { ...r, id: uuidv4(), timestamp: new Date().toISOString() };
  artifacts.push(rec);
  persistAuditRecord("artifact", rec);
  return rec;
}
export function recordCodeChange(r: Omit<CodeChangeRecord, "id" | "timestamp">): CodeChangeRecord {
  const rec: CodeChangeRecord = { ...r, id: `cc_${uuidv4()}`, timestamp: new Date().toISOString() };
  codeChanges.push(rec);
  persistAuditRecord("code_change", rec);
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
