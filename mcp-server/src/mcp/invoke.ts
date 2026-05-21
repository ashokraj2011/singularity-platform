/**
 * /mcp/invoke + /mcp/resume — the agent-loop entry points (M9.z).
 *
 * The loop is extracted into `runLoop()` so it can be driven by:
 *   - POST /mcp/invoke   — initial run; builds state from request body
 *   - POST /mcp/resume   — continuation after human approval; rebuilds
 *                          state from a saved PendingApproval envelope
 *
 * When an approval-required tool is encountered, runLoop() saves the full
 * loop state under a continuation_token, emits `approval.wait.created`,
 * and returns a WAITING_APPROVAL outcome. The loop EXITS at that point;
 * /mcp/resume picks it up later with the operator's decision.
 */
import { Router } from "express";
import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { config } from "../config";
import { log } from "../shared/log";
import { AppError, NotFoundError } from "../shared/errors";
import { llmRespond } from "../llm/client";
import { ChatMessage, LlmResponse, ToolCall, ToolDescriptorForLlm } from "../llm/types";
import { resolveModelConfig } from "../llm/model-catalog";
import { getLocalTool, listLocalTools } from "../tools/registry";
import { runVerificationCommand } from "../tools/command";
import { detectVerifiers } from "../workspace/verifier-registry";
import {
  CorrelationIds, recordLlmCall, recordToolInvocation, recordArtifact,
  recordCodeChange, ToolInvocationRecord, CodeChangeRecord,
} from "../audit/store";
import { emitRePlan } from "../audit/replan-telemetry";
import { extractCodeChange } from "../audit/provenanceExtractor";
import { events } from "../events/bus";
import { emitAuditEvent } from "../lib/audit-gov-emit";
import { checkBudget, checkRateLimit, GovernanceMode } from "../lib/audit-gov-check";
import { isDegradedToolAllowedByPolicy, isRiskyToolByPolicy } from "../lib/governance-policy";
import { persistApproval, consumeApproval } from "../lib/audit-gov-approvals";
import {
  savePending, takePending, peekPending, PendingToolDescriptor,
} from "../audit/pending";
import {
  branchNameForWork, finishWorkBranch, prepareWorkBranch, restoreWorkBranch, WorkBranchInfo,
  createCheckpoint, cleanupCheckpoints,
} from "../workspace/git-workspace";
// M39 — PII masking helpers. Both sync (regex baseline) and async (regex+NER).
import { maskPii, maskPiiAsync, unmaskPiiInArgs } from "../security/mask";
import { indexWorkspace, lastAstStats } from "../workspace/ast-index";
import { ensureWorkspaceSource, WorkspaceSourceStatus } from "../workspace/source-materializer";
import {
  gcWorkItemWorkspaces, sandboxRoot, withSandboxRoot, withWorkspaceLock, workspaceRootForRunContext,
} from "../workspace/sandbox";

const ToolDescSchema = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.unknown()),
  execution_target: z.enum(["LOCAL", "SERVER"]).default("LOCAL"),
  version: z.string().optional(),
  natural_language: z.string().optional(),
  risk_level: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  requires_approval: z.boolean().optional(),
  // M39 — When true, mcp-server masks PII in this tool's output before the
  // LLM sees it. See src/security/mask.ts. Default false (no change to
  // existing tools). Toolset opt-in by tool-service / context-fabric.
  pii_sensitive: z.boolean().optional(),
});

const InvokeSchema = z.object({
  systemPrompt: z.string().optional(),
  history: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    tool_call_id: z.string().optional(),
    tool_name: z.string().optional(),
  })).default([]),
  message: z.string(),
  tools: z.array(ToolDescSchema).default([]),
  modelConfig: z.object({
    modelAlias: z.string().optional(),
    applierModelAlias: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int().optional(),
    promptCache: z.object({
      enabled: z.boolean().optional(),
      strategy: z.string().optional(),
      key: z.string().optional(),
    }).optional(),
  }).default({}),
  runContext: z.object({
    sessionId: z.string().optional(),
    capabilityId: z.string().optional(),
    tenantId: z.string().optional(),
    agentId: z.string().optional(),
    runId: z.string().optional(),
    runStepId: z.string().optional(),
    workItemId: z.string().optional(),
    workItemCode: z.string().optional(),
    traceId: z.string().optional(),
    workflowInstanceId: z.string().optional(),
    nodeId: z.string().optional(),
    branchBase: z.string().optional(),
    branchName: z.string().optional(),
    workspaceRoot: z.string().optional(),
    sourceType: z.string().optional(),
    sourceUri: z.string().optional(),
    sourceRef: z.string().optional(),
    dependencyState: z.object({
      changed_paths: z.array(z.string()).optional(),
    }).optional(),
  }).default({}),
  limits: z.object({
    maxSteps: z.number().int().positive().optional(),
    timeoutSec: z.number().int().positive().optional(),
    maxToolResultChars: z.number().int().positive().optional(),
    maxHistoryMessages: z.number().int().positive().optional(),
    maxHistoryTokens: z.number().int().positive().optional(),
    compressToolResults: z.boolean().optional(),
    includeLocalTools: z.boolean().optional(),
  }).default({}),
  governanceMode: z.enum(["fail_open", "fail_closed", "degraded", "human_approval_required"]).default("fail_open"),
  contextPlanHash: z.string().optional(),
  degradedActionsAllowed: z.array(z.string()).default([]),
  allowAutonomousMutation: z.boolean().optional(),
});

const ResumeSchema = z.object({
  continuation_token: z.string(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().optional(),
  args_override: z.record(z.unknown()).optional(),
});

export const invokeRouter = Router();

// ── Loop state (shared between /invoke and /resume) ──────────────────────

interface LoopState {
  messages: ChatMessage[];
  availableTools: ToolDescriptorForLlm[];           // what the LLM sees
  fullToolDescriptors: PendingToolDescriptor[];     // execution_target + approval flag
  modelConfig: {
    modelAlias?: string;
    applierModelAlias?: string;
    provider: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    promptCache?: {
      enabled?: boolean;
      strategy?: string;
      key?: string;
    };
    warnings?: string[];
  };
  correlation: CorrelationIds;
  stepIndex: number;
  maxSteps: number;
  maxToolResultChars?: number;
  maxHistoryMessages?: number;
  maxHistoryTokens?: number;
  compressToolResults?: boolean;
  llmCallIds: string[];
  toolInvocationIds: string[];
  artifactIds: string[];
  codeChangeIds: string[];
  verificationReceipts: Array<Record<string, unknown>>;
  promptCacheUsage: Array<Record<string, unknown>>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCost: number;
  contextCompression: {
    messagesDropped: number;
    tokensDropped: number;
    toolResultsCompressed: number;
    toolResultBytesSaved: number;
  };
  // Repetition detector (catches gpt-4o pathology where the LLM loops on the
  // same tool call without progressing). Trims to last LOOP_REPETITION_WINDOW
  // entries — we only care about consecutive repetitions, not lifetime.
  toolCallHistory: Array<{ name: string; argsHash: string; stepIndex: number }>;
  toolUseNudgeCount: number;
  workspace?: {
    branch?: WorkBranchInfo | null;
    workspaceRoot?: string;
    commitSha?: string;
    changedPaths?: string[];
    astIndexStatus?: string;
    astIndexedFiles?: number;
    astIndexedSymbols?: number;
    source?: WorkspaceSourceStatus | null;
    formalRepairAttempted?: boolean;
  };
  governanceMode: GovernanceMode;
  contextPlanHash?: string;
  degradedActionsAllowed: string[];
  allowAutonomousMutation: boolean;
  // M39 — PII token map. Carried across the loop and (when serialized
  // into PendingApproval) across human-approval pauses. Map shape:
  //   { "[EMAIL_1]": "alice@example.com", "[SSN_1]": "123-45-6789" }
  // The LLM sees masked tokens; mcp-server un-masks args before tool
  // dispatch so downstream enterprise APIs receive real values.
  // Empty map by default; populated lazily on the first masked output.
  piiTokenMap: Record<string, string>;
  rePlanDepth: number;
  // Compressed run history. Each entry is one line summarizing a dropped
  // assistant+tool exchange (e.g. "- read_file(path=X.java) → 245 lines").
  // Surfaces to the LLM as a pinned user message after the anchor so the
  // agent doesn't re-explore files it already touched.
  breadcrumbs: string[];
}

type LoopOutcome =
  | { kind: "complete"; finalContent: string; finishReason: "stop" | "length" | "error" | "max_steps" }
  | {
      kind: "paused";
      continuationToken: string;
      pendingToolCall: ToolCall;
      pendingDescriptor: PendingToolDescriptor;
      finishReason: "approval_required";
    }
  | {
      kind: "denied";
      // M22 — pre-flight governance denial (budget exhausted or rate-limit hit)
      // M28 — agent_loop.repetition_detected uses kind:"denied" too
      finishReason: "governance_denied" | "agent_loop_repetition";
      reason: string;
      check: "budget" | "rate_limit" | "loop_repetition" | "tool_policy";
      details?: Record<string, unknown>;
    };

// M28 boot-1 — repetition detector tunables. The LLM is loop-pathological when
// it calls the SAME tool with the SAME args ≥ N times consecutively without
// progress. Default: 3 strikes within a 5-call window. Env-gated so demos can
// loosen if a model legitimately needs to re-read.
const LOOP_REPETITION_THRESHOLD = Number(process.env.MCP_LOOP_REPETITION_THRESHOLD ?? 3);
const LOOP_REPETITION_WINDOW    = Number(process.env.MCP_LOOP_REPETITION_WINDOW ?? 5);

function argsHash(args: Record<string, unknown> | undefined): string {
  // Stable hash via sorted JSON. Empty/undefined hashes consistently so
  // a no-arg tool called repeatedly is also caught.
  if (!args) return "∅";
  try { return JSON.stringify(args, Object.keys(args).sort()); }
  catch { return String(args); }
}

function detectRepetition(history: LoopState["toolCallHistory"]): { name: string; count: number } | null {
  if (history.length < LOOP_REPETITION_THRESHOLD) return null;
  const window = history.slice(-LOOP_REPETITION_WINDOW);
  // Count consecutive matches at the tail.
  const tail = window[window.length - 1];
  let count = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].name === tail.name && window[i].argsHash === tail.argsHash) count++;
    else break;
  }
  return count >= LOOP_REPETITION_THRESHOLD ? { name: tail.name, count } : null;
}

function hasTool(state: LoopState, names: string[]): boolean {
  const available = new Set(state.fullToolDescriptors.map((tool) => tool.name));
  return names.some((name) => available.has(name));
}

function verificationReceiptsFromOutput(
  output: unknown,
  toolInvocationId: string,
  toolName: string,
): Array<Record<string, unknown>> {
  const receipts: Array<Record<string, unknown>> = [];
  collectVerificationReceipts(output, toolInvocationId, toolName, receipts);
  return receipts;
}

function collectVerificationReceipts(
  output: unknown,
  toolInvocationId: string,
  toolName: string,
  receipts: Array<Record<string, unknown>>,
): void {
  if (!output || typeof output !== "object") return;
  if (Array.isArray(output)) {
    for (const item of output) {
      collectVerificationReceipts(item, toolInvocationId, toolName, receipts);
    }
    return;
  }
  const record = output as Record<string, unknown>;
  const kind = String(record.kind ?? record.type ?? "").toLowerCase();
  const looksLikeVerification =
    kind === "verification_result" ||
    kind === "test_result" ||
    Boolean(record.command && ("exit_code" in record || "exitCode" in record || "passed" in record));
  if (looksLikeVerification) {
    receipts.push({
      ...record,
      toolInvocationId: typeof record.toolInvocationId === "string" ? record.toolInvocationId : toolInvocationId,
      toolName: typeof record.toolName === "string" ? record.toolName : toolName,
      capturedAt: typeof record.capturedAt === "string" ? record.capturedAt : new Date().toISOString(),
    });
    return;
  }
  for (const value of Object.values(record)) {
    collectVerificationReceipts(value, toolInvocationId, toolName, receipts);
  }
}

function verificationExecutionMetadata(output: unknown): Record<string, unknown> {
  const receipt = findVerificationReceipt(output);
  if (!receipt) return {};
  const keys = [
    "verification_kind",
    "command",
    "passed",
    "timed_out",
    "execution_mode",
    "runner_receipt_id",
    "container_image",
    "container_id",
    "network_mode",
    "isolation",
  ];
  return Object.fromEntries(keys.filter((key) => key in receipt).map((key) => [key, receipt[key]]));
}

function findVerificationReceipt(output: unknown): Record<string, unknown> | null {
  if (!output || typeof output !== "object") return null;
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = findVerificationReceipt(item);
      if (found) return found;
    }
    return null;
  }
  const record = output as Record<string, unknown>;
  const kind = String(record.kind ?? record.type ?? "").toLowerCase();
  if (
    kind === "verification_result" ||
    kind === "test_result" ||
    Boolean(record.command && ("exit_code" in record || "exitCode" in record || "passed" in record))
  ) {
    return record;
  }
  for (const value of Object.values(record)) {
    const found = findVerificationReceipt(value);
    if (found) return found;
  }
  return null;
}

function shouldNudgeForCodeToolUse(state: LoopState, llmResp: LlmResponse): boolean {
  if (!state.allowAutonomousMutation || state.toolUseNudgeCount >= 1) return false;
  if (llmResp.finish_reason === "tool_call" && llmResp.tool_calls?.length) return false;
  if (!state.workspace?.workspaceRoot) return false;
  const hasInspectionTools = hasTool(state, ["find_symbol", "get_symbol", "get_ast_slice", "get_dependencies", "search_code", "read_file"]);
  const hasMutationTools = hasTool(state, ["apply_patch", "write_file", "git_commit", "finish_work_branch"]);
  return hasInspectionTools && hasMutationTools;
}

// M36.7 — code-tool-use nudge prompt is fetched from prompt-composer
// (SystemPrompt key "mcp.code-tool-use-nudge"). In-process cached so the
// hot agent loop doesn't HTTP every step. mcp-server lives outside the
// agent-and-tools workspace so we inline the cache helper.
const NUDGE_PROMPT_KEY = "mcp.code-tool-use-nudge";
let cachedNudgePrompt: string | null = null;
let cachedNudgePromptAt = 0;
const NUDGE_PROMPT_TTL_MS = Number(process.env.SYSTEM_PROMPT_CACHE_TTL_SEC ?? 300) * 1000;

async function getNudgePrompt(): Promise<string> {
  if (cachedNudgePrompt && Date.now() - cachedNudgePromptAt < NUDGE_PROMPT_TTL_MS) {
    return cachedNudgePrompt;
  }
  const composerUrl = process.env.PROMPT_COMPOSER_URL?.trim();
  if (!composerUrl) {
    throw new Error(
      "PROMPT_COMPOSER_URL is not set. mcp-server's code-tool-use nudge prompt is owned by prompt-composer (key mcp.code-tool-use-nudge).",
    );
  }
  const url = `${composerUrl.replace(/\/$/, "")}/api/v1/system-prompts/${encodeURIComponent(NUDGE_PROMPT_KEY)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) {
    if (cachedNudgePrompt) return cachedNudgePrompt; // stale-ok
    throw new Error(`mcp-server nudge prompt fetch ${NUDGE_PROMPT_KEY} failed: ${res.status}`);
  }
  const body = await res.json() as { success: boolean; data: { content: string } };
  if (!body.success) {
    if (cachedNudgePrompt) return cachedNudgePrompt;
    throw new Error(`mcp-server nudge prompt fetch returned success=false`);
  }
  cachedNudgePrompt = body.data.content;
  cachedNudgePromptAt = Date.now();
  return cachedNudgePrompt;
}

const APPLIER_PROMPT_KEY = "mcp.applier-system";
let cachedApplierPrompt: string | null = null;
let cachedApplierPromptAt = 0;

async function getApplierPrompt(): Promise<string> {
  const DEFAULT_APPLIER_PROMPT = `You are a precise code applier. Your task is to apply surgical edits to the codebase using the available mutation tools (replace_text, replace_range, apply_patch, write_file) to satisfy the user's requirements. Do not write explanations outside of tool calls.`;
  if (cachedApplierPrompt && Date.now() - cachedApplierPromptAt < NUDGE_PROMPT_TTL_MS) {
    return cachedApplierPrompt;
  }
  const composerUrl = process.env.PROMPT_COMPOSER_URL?.trim();
  if (!composerUrl) {
    return DEFAULT_APPLIER_PROMPT;
  }
  const url = `${composerUrl.replace(/\/$/, "")}/api/v1/system-prompts/${encodeURIComponent(APPLIER_PROMPT_KEY)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      if (cachedApplierPrompt) return cachedApplierPrompt;
      return DEFAULT_APPLIER_PROMPT;
    }
    const body = await res.json() as { success: boolean; data: { content: string } };
    if (body.success && body.data?.content) {
      cachedApplierPrompt = body.data.content;
      cachedApplierPromptAt = Date.now();
      return cachedApplierPrompt;
    }
  } catch (err) {
    if (cachedApplierPrompt) return cachedApplierPrompt;
  }
  return DEFAULT_APPLIER_PROMPT;
}


async function appendCodeToolUseNudge(state: LoopState, llmResp: LlmResponse): Promise<void> {
  if (llmResp.content) {
    state.messages.push({
      role: "assistant",
      content: llmResp.content,
    });
  }
  state.messages.push({
    role: "user",
    content: await getNudgePrompt(),
  });
  state.toolUseNudgeCount += 1;
}

function isDegradedToolAllowed(state: LoopState, name: string, desc?: PendingToolDescriptor): boolean {
  return isDegradedToolAllowedByPolicy(name, desc, state.degradedActionsAllowed);
}

type DispatchToolResult = {
  record: ToolInvocationRecord;
  codeChange?: CodeChangeRecord;
  approvalRequired?: {
    reason?: string;
    riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  };
};

async function runLoop(state: LoopState): Promise<LoopOutcome> {
  while (state.stepIndex < state.maxSteps) {
    applySlidingWindow(state);
    // Governance checks run before each model turn. The requested governance
    // mode decides whether audit-gov outages fail open, fail closed, or force
    // a restricted/degraded posture.
    const estimatedTokens = estimateLoopInputTokens(state);
    const [budgetRes, rateRes] = await Promise.all([
      checkBudget(state.correlation.capabilityId, undefined, estimatedTokens, state.governanceMode),
      checkRateLimit(state.correlation.capabilityId, undefined, state.governanceMode),
    ]);
    for (const [check, res] of [["budget", budgetRes], ["rate_limit", rateRes]] as const) {
      if (res.unavailable) {
        emitAuditEvent({
          trace_id: state.correlation.traceId,
          source_service: "mcp-server",
          kind: "governance.check.unavailable",
          capability_id: state.correlation.capabilityId,
          severity: state.governanceMode === "fail_open" ? "warn" : "error",
          payload: { check, reason: res.reason, governanceMode: state.governanceMode, contextPlanHash: state.contextPlanHash },
        });
      }
    }
    if (!budgetRes.allowed) {
      const reason = budgetRes.reason ?? "budget exhausted";
      emitAuditEvent({
        trace_id: state.correlation.traceId,
        source_service: "mcp-server",
        kind: "governance.denied",
        capability_id: state.correlation.capabilityId,
        severity: "warn",
        payload: { check: "budget", reason, budgets: budgetRes.budgets ?? [], governanceMode: state.governanceMode, contextPlanHash: state.contextPlanHash },
      });
      return { kind: "denied", finishReason: "governance_denied", reason, check: "budget", details: { budgets: budgetRes.budgets } };
    }
    if (!rateRes.allowed) {
      const reason = rateRes.reason ?? "rate limit exceeded";
      emitAuditEvent({
        trace_id: state.correlation.traceId,
        source_service: "mcp-server",
        kind: "governance.denied",
        capability_id: state.correlation.capabilityId,
        severity: "warn",
        payload: { check: "rate_limit", reason, rate_limits: rateRes.rate_limits ?? [], governanceMode: state.governanceMode, contextPlanHash: state.contextPlanHash },
      });
      return { kind: "denied", finishReason: "governance_denied", reason, check: "rate_limit", details: { rate_limits: rateRes.rate_limits } };
    }

    events.publish({
      kind: "llm.request",
      correlation: { ...state.correlation },
      payload: {
        modelAlias: state.modelConfig.modelAlias,
        provider: state.modelConfig.provider,
        model: state.modelConfig.model,
        prompt_messages_count: state.messages.length,
        stepIndex: state.stepIndex,
        contextCompression: state.contextCompression,
        promptCache: state.modelConfig.promptCache,
      },
    });

    const llmResp = await llmRespond({
      model_alias: state.modelConfig.modelAlias,
      provider: state.modelConfig.provider,
      model: state.modelConfig.model,
      messages: state.messages,
      tools: state.availableTools,
      temperature: state.modelConfig.temperature,
      max_output_tokens: state.modelConfig.maxTokens,
      prompt_cache: state.modelConfig.promptCache,
    }, {
      onDelta: async (delta) => {
        if (!delta.content) return;
        events.publish({
          kind: "llm.stream.delta",
          correlation: { ...state.correlation },
          payload: {
            modelAlias: state.modelConfig.modelAlias,
            provider: state.modelConfig.provider,
            model: state.modelConfig.model,
            stepIndex: state.stepIndex,
            content: delta.content,
            index: delta.index,
          },
        });
      },
    });
    state.totalInputTokens += llmResp.input_tokens;
    state.totalOutputTokens += llmResp.output_tokens;
    if (typeof llmResp.estimated_cost === "number" && Number.isFinite(llmResp.estimated_cost)) {
      state.totalEstimatedCost += llmResp.estimated_cost;
    }
    if (llmResp.provider) state.modelConfig.provider = llmResp.provider;
    if (llmResp.model) state.modelConfig.model = llmResp.model;
    if (llmResp.model_alias) state.modelConfig.modelAlias = llmResp.model_alias;

    const llmRec = recordLlmCall({
      correlation: state.correlation,
      model_alias: state.modelConfig.modelAlias,
      provider: state.modelConfig.provider,
      model: state.modelConfig.model,
      input_tokens: llmResp.input_tokens,
      output_tokens: llmResp.output_tokens,
      estimated_cost: llmResp.estimated_cost,
      latency_ms: llmResp.latency_ms,
      prompt_messages_count: state.messages.length,
      finish_reason: llmResp.finish_reason,
    });
    state.llmCallIds.push(llmRec.id);

    // [diag] Per-step trace — one structured line per LLM turn so we can
    // see exactly what the agent did and why it hit max_steps. Enable/grep
    // by trace id. Cheap; safe to leave on in dev.
    log.info({
      step: state.stepIndex,
      trace: state.correlation.traceId,
      finish: llmResp.finish_reason,
      in_msgs: state.messages.length,
      in_tokens: llmResp.input_tokens,
      out_tokens: llmResp.output_tokens,
      dropped_msgs: state.contextCompression.messagesDropped,
      breadcrumbs: state.breadcrumbs.length,
      tool_calls: llmResp.tool_calls?.map((tc) => `${tc.name}(${briefArgs(tc.args)})`) ?? null,
      text_preview: llmResp.content
        ? String(llmResp.content).replace(/\s+/g, " ").slice(0, 140)
        : null,
    }, "[agent-step]");

    if (llmResp.prompt_cache) {
      state.promptCacheUsage.push({
        ...llmResp.prompt_cache,
        llmCallId: llmRec.id,
        stepIndex: state.stepIndex,
        provider: state.modelConfig.provider,
        model: state.modelConfig.model,
        modelAlias: state.modelConfig.modelAlias,
        capturedAt: new Date().toISOString(),
      });
    }

    // M21 — fire-and-forget to audit-governance-service. Failures land in
    // logs only and never block the agent loop.
    emitAuditEvent({
      trace_id:      state.correlation.traceId,
      source_service: "mcp-server",
      kind:          "llm.call.completed",
      subject_type:  "LlmCall",
      subject_id:    llmRec.id,
      capability_id: state.correlation.capabilityId,
      severity:      "info",
      payload: {
        model_alias:   state.modelConfig.modelAlias,
        provider:      state.modelConfig.provider,
        model:         state.modelConfig.model,
        input_tokens:  llmResp.input_tokens,
        output_tokens: llmResp.output_tokens,
        total_tokens:  llmResp.input_tokens + llmResp.output_tokens,
        estimated_cost: llmResp.estimated_cost,
        latency_ms:    llmResp.latency_ms,
        finish_reason: llmResp.finish_reason,
        prompt_cache: llmResp.prompt_cache,
      },
    });

    events.publish({
      kind: "llm.response",
      correlation: { ...state.correlation, llmCallId: llmRec.id },
      payload: {
        modelAlias: state.modelConfig.modelAlias,
        finish_reason: llmResp.finish_reason,
        input_tokens: llmResp.input_tokens,
        output_tokens: llmResp.output_tokens,
        estimated_cost: llmResp.estimated_cost,
        latency_ms: llmResp.latency_ms,
        tool_calls_count: llmResp.tool_calls?.length ?? 0,
        promptCache: llmResp.prompt_cache,
      },
    });

    if (
      llmResp.finish_reason === "stop" &&
      state.modelConfig.applierModelAlias &&
      state.allowAutonomousMutation &&
      state.availableTools.some((t) => ["replace_text", "replace_range", "apply_patch", "write_file"].includes(t.name))
    ) {
      const estimatedTokens = Math.ceil((llmResp.content ?? "").length / 4) + 1000;
      const applierBudget = await checkBudget(
        state.correlation.capabilityId,
        undefined,
        estimatedTokens,
        state.governanceMode,
      );
      if (applierBudget.allowed) {
        const applierPrompt = await getApplierPrompt();
        const applierResp = await llmRespond({
          model_alias: state.modelConfig.applierModelAlias,
          messages: [
            { role: "system", content: applierPrompt },
            { role: "user", content: llmResp.content ?? "" },
          ],
          tools: state.availableTools.filter((t) =>
            ["replace_text", "replace_range", "apply_patch", "write_file"].includes(t.name)
          ),
        });

        state.totalInputTokens += applierResp.input_tokens;
        state.totalOutputTokens += applierResp.output_tokens;
        if (typeof applierResp.estimated_cost === "number" && Number.isFinite(applierResp.estimated_cost)) {
          state.totalEstimatedCost += applierResp.estimated_cost;
        }

        const applierLlmRec = recordLlmCall({
          correlation: state.correlation,
          model_alias: state.modelConfig.applierModelAlias,
          provider: applierResp.provider || "unknown",
          model: applierResp.model || "unknown",
          input_tokens: applierResp.input_tokens,
          output_tokens: applierResp.output_tokens,
          estimated_cost: applierResp.estimated_cost,
          latency_ms: applierResp.latency_ms,
          prompt_messages_count: 2,
          finish_reason: applierResp.finish_reason,
        });
        state.llmCallIds.push(applierLlmRec.id);

        emitAuditEvent({
          trace_id: state.correlation.traceId,
          source_service: "mcp-server",
          kind: "llm.call.completed",
          subject_type: "LlmCall",
          subject_id: applierLlmRec.id,
          capability_id: state.correlation.capabilityId,
          severity: "info",
          payload: {
            model_alias: state.modelConfig.applierModelAlias,
            role: "applier",
            input_tokens: applierResp.input_tokens,
            output_tokens: applierResp.output_tokens,
            estimated_cost: applierResp.estimated_cost,
            latency_ms: applierResp.latency_ms,
            finish_reason: applierResp.finish_reason,
          },
        });

        if (applierResp.finish_reason === "tool_call" && applierResp.tool_calls?.length) {
          const applierMutatedPaths: string[] = [];

          state.messages.push({
            role: "assistant",
            content: JSON.stringify({ tool_calls: applierResp.tool_calls }),
          });

          for (const tc of applierResp.tool_calls) {
            const desc = state.fullToolDescriptors.find((d) => d.name === tc.name);
            const toolArgs = applyArgsUnmaskIfNeeded(state, tc.args ?? {});
            const result = await dispatchToolCall(
              { ...tc, args: toolArgs },
              state.fullToolDescriptors,
              state.correlation,
              undefined,
              state.workspace?.workspaceRoot,
            );
            state.toolInvocationIds.push(result.record.id);
            if (result.codeChange) {
              state.codeChangeIds.push(result.codeChange.id);
              if (result.codeChange.paths_touched) {
                applierMutatedPaths.push(...result.codeChange.paths_touched);
              }
            }
            state.verificationReceipts.push(
              ...verificationReceiptsFromOutput(result.record.output, result.record.id, tc.name)
            );

            if (result.record.error_code === "CONFLICT") {
              state.rePlanDepth++;
              emitRePlan(state.correlation, {
                trigger: "conflict_detected",
                step_index: state.stepIndex,
                convergence_depth: state.rePlanDepth,
                conflicted_paths: [tc.args?.path as string].filter(Boolean),
              });
            }

            if (result.approvalRequired) {
              return await pauseForApproval(state, tc, desc, result.approvalRequired.reason, result.record.id);
            }

            const rawOutput = toolResultForNextTurn(state, result.record.output);
            const maskedOutput = await applyOutputMaskIfNeededAsync(state, undefined, rawOutput);
            state.messages.push({
              role: "tool",
              content: maskedOutput,
              tool_call_id: tc.id,
              tool_name: tc.name,
            });
          }

          if (applierMutatedPaths.length > 0 && state.workspace?.workspaceRoot) {
            const uniqueMutatedPaths = Array.from(new Set(applierMutatedPaths));
            const allVerifiers = await detectVerifiers(state.workspace.workspaceRoot);
            const activeVerifiers = allVerifiers.filter((v) => {
              const matching = uniqueMutatedPaths.filter((p) => v.filePatterns.some((pat) => p.endsWith(pat)));
              return matching.length > 0;
            });

            if (activeVerifiers.length > 0) {
              const priority: Record<string, number> = { compile: 4, typecheck: 3, lint: 2, test: 1 };
              activeVerifiers.sort((a, b) => (priority[b.kind] ?? 0) - (priority[a.kind] ?? 0));

              const selectedVerifiers = activeVerifiers.slice(0, 3);
              let anyFailure = false;
              const failureMessages: string[] = [];

              for (const verifier of selectedVerifiers) {
                const matching = uniqueMutatedPaths.filter((p) => verifier.filePatterns.some((pat) => p.endsWith(pat)));
                const runArgs = verifier.perFile ? [...verifier.args, ...matching] : verifier.args;

                try {
                  const res = await runVerificationCommand({
                    command: verifier.command,
                    args: runArgs,
                    cwd: ".",
                    timeout_ms: verifier.timeout_ms,
                  });

                  const outputObj = (res.output || {}) as Record<string, unknown>;
                  const exitCode = typeof outputObj.exitCode === "number" ? outputObj.exitCode : (typeof outputObj.exit_code === "number" ? outputObj.exit_code : -1);
                  const passed = res.success && (exitCode === 0 || outputObj.passed === true);
                  const stdout = String(outputObj.stdout ?? "");
                  const stderr = String(outputObj.stderr ?? "");

                  if (passed) {
                    state.verificationReceipts.push({
                      kind: "verification_result",
                      verification_kind: verifier.kind,
                      verifier_name: verifier.name,
                      command: `${verifier.command} ${runArgs.join(" ")}`,
                      passed: true,
                      exit_code: 0,
                      capturedAt: new Date().toISOString(),
                    });
                  } else {
                    anyFailure = true;
                    failureMessages.push(`[VERIFICATION FAILURE]
Verifier: ${verifier.name} (${verifier.kind})
Command: ${verifier.command} ${runArgs.join(" ")}
Exit Code: ${exitCode}

Stdout:
${stdout}

Stderr:
${stderr}`);

                    state.verificationReceipts.push({
                      kind: "verification_result",
                      verification_kind: verifier.kind,
                      verifier_name: verifier.name,
                      command: `${verifier.command} ${runArgs.join(" ")}`,
                      passed: false,
                      exit_code: exitCode,
                      stdout,
                      stderr,
                      capturedAt: new Date().toISOString(),
                    });
                  }
                } catch (err) {
                  anyFailure = true;
                  failureMessages.push(`[VERIFICATION FAILURE]
Verifier: ${verifier.name} (${verifier.kind})
Command: ${verifier.command} ${runArgs.join(" ")}
Exit Code: -1

Stdout:
${(err as Error).message}

Stderr:
${(err as Error).stack ?? ""}`);

                  state.verificationReceipts.push({
                    kind: "verification_result",
                    verification_kind: verifier.kind,
                    verifier_name: verifier.name,
                    command: `${verifier.command} ${runArgs.join(" ")}`,
                    passed: false,
                    exit_code: -1,
                    error: (err as Error).message,
                    capturedAt: new Date().toISOString(),
                  });
                }
              }

              if (anyFailure) {
                state.rePlanDepth++;
                emitRePlan(state.correlation, {
                  trigger: "verification_failure",
                  step_index: state.stepIndex,
                  convergence_depth: state.rePlanDepth,
                });

                const content = `Auto-verification failed. Please fix these verification failures before proceeding:

${failureMessages.join("\n\n")}

Please review the errors above, correct the code, and explain how you resolved the issues.`;

                state.messages.push({
                  role: "user",
                  content,
                });
              }
            }
          }

          if (applierMutatedPaths.length > 0) {
            await createCheckpoint(applierMutatedPaths, state.stepIndex, state.correlation).catch((err) => {
              log.warn(`[checkpoint] failed to create checkpoint: ${err.message}`);
            });
          }

          state.stepIndex += 1;
          continue;
        }
      }
    }

    if (llmResp.finish_reason === "tool_call" && llmResp.tool_calls?.length) {
      // Record the assistant turn so resumed conversations stay coherent.
      state.messages.push({
        role: "assistant",
        content: JSON.stringify({ tool_calls: llmResp.tool_calls }),
      });

      const mutatedPaths: string[] = [];
      for (const tc of llmResp.tool_calls) {
        const desc = state.fullToolDescriptors.find((d) => d.name === tc.name);
        const handler = desc?.execution_target === "LOCAL" ? getLocalTool(tc.name) : undefined;
        if (state.governanceMode === "degraded" && !isDegradedToolAllowed(state, tc.name, desc)) {
          const reason = `degraded governance mode blocks tool ${tc.name}; only low-risk read-only local tools are allowed.`;
          emitAuditEvent({
            trace_id: state.correlation.traceId,
            source_service: "mcp-server",
            kind: "governance.denied",
            capability_id: state.correlation.capabilityId,
            severity: "warn",
            payload: {
              check: "tool_policy",
              reason,
              tool_name: tc.name,
              execution_target: desc?.execution_target,
              risk_level: desc?.risk_level,
              governanceMode: state.governanceMode,
              contextPlanHash: state.contextPlanHash,
            },
          });
          return { kind: "denied", finishReason: "governance_denied", reason, check: "tool_policy", details: { tool_name: tc.name, governanceMode: state.governanceMode } };
        }

        const risky = isRiskyToolByPolicy(tc.name, desc);
        const requiresApproval =
          desc?.requires_approval ||
          handler?.descriptor.requires_approval ||
          (risky && !state.allowAutonomousMutation) ||
          (state.governanceMode === "human_approval_required" && risky && !state.allowAutonomousMutation);

        if (requiresApproval) {
          return await pauseForApproval(
            state,
            tc,
            desc,
            risky ? "Governance requires approval before risky or mutating tool execution." : undefined,
          );
        }

        // Normal dispatch path.
        // M39 — un-mask any PII tokens in args before the tool runs. tc.args
        // came from the LLM which only saw masked tokens; the downstream
        // enterprise API needs the real values back.
        const toolArgs = applyArgsUnmaskIfNeeded(state, tc.args ?? {});
        if (tc.name === "finish_work_branch") {
          toolArgs.verificationReceipts = state.verificationReceipts;
        }
        const unmaskedTc = { ...tc, args: toolArgs };
        const result = await dispatchToolCall(
          unmaskedTc,
          state.fullToolDescriptors,
          state.correlation,
          undefined,
          state.workspace?.workspaceRoot,
        );
        state.toolInvocationIds.push(result.record.id);
        if (result.codeChange) {
          state.codeChangeIds.push(result.codeChange.id);
          if (result.codeChange.paths_touched) {
            mutatedPaths.push(...result.codeChange.paths_touched);
          }
        }
        state.verificationReceipts.push(...verificationReceiptsFromOutput(result.record.output, result.record.id, tc.name));
        if (result.record.error_code === "CONFLICT") {
          state.rePlanDepth++;
          emitRePlan(state.correlation, {
            trigger: "conflict_detected",
            step_index: state.stepIndex,
            convergence_depth: state.rePlanDepth,
            conflicted_paths: [tc.args?.path as string].filter(Boolean),
          });
        }
        if (result.approvalRequired) {
          return await pauseForApproval(state, tc, desc, result.approvalRequired.reason, result.record.id);
        }
        // M39 — mask PII in the tool output before the LLM sees it. M39.B
        // upgrades the path to async so the NER detector (loaded lazily under
        // MCP_PII_NER_ENABLED) can run alongside the regex baseline.
        const rawOutput = toolResultForNextTurn(state, result.record.output);
        const maskedOutput = await applyOutputMaskIfNeededAsync(state, desc, rawOutput);
        state.messages.push({
          role: "tool",
          content: maskedOutput,
          tool_call_id: tc.id,
          tool_name: tc.name,
        });

        // M28 boot-1 — repetition detector.
        state.toolCallHistory.push({
          name: tc.name,
          argsHash: argsHash(tc.args),
          stepIndex: state.stepIndex,
        });
        if (state.toolCallHistory.length > LOOP_REPETITION_WINDOW * 2) {
          state.toolCallHistory.splice(0, state.toolCallHistory.length - LOOP_REPETITION_WINDOW * 2);
        }
        const rep = detectRepetition(state.toolCallHistory);
        if (rep) {
          const reason = `LLM looped on ${rep.name} (${rep.count} consecutive identical calls, threshold=${LOOP_REPETITION_THRESHOLD}). Agent is not making progress.`;
          emitAuditEvent({
            trace_id:      state.correlation.traceId,
            source_service: "mcp-server",
            kind:          "agent_loop.repetition_detected",
            capability_id: state.correlation.capabilityId,
            severity:      "warn",
            payload: { tool_name: rep.name, repetition_count: rep.count, threshold: LOOP_REPETITION_THRESHOLD, stepIndex: state.stepIndex },
          });
          return { kind: "denied", finishReason: "agent_loop_repetition", reason, check: "loop_repetition", details: { tool_name: rep.name, repetition_count: rep.count } };
        }
      }

      if (mutatedPaths.length > 0 && state.workspace?.workspaceRoot) {
        const uniqueMutatedPaths = Array.from(new Set(mutatedPaths));
        const allVerifiers = await detectVerifiers(state.workspace.workspaceRoot);
        const activeVerifiers = allVerifiers.filter(v => {
          const matching = uniqueMutatedPaths.filter(p => v.filePatterns.some(pat => p.endsWith(pat)));
          return matching.length > 0;
        });

        if (activeVerifiers.length > 0) {
          const priority: Record<string, number> = { compile: 4, typecheck: 3, lint: 2, test: 1 };
          activeVerifiers.sort((a, b) => (priority[b.kind] ?? 0) - (priority[a.kind] ?? 0));

          const selectedVerifiers = activeVerifiers.slice(0, 3);
          let anyFailure = false;
          const failureMessages: string[] = [];

          for (const verifier of selectedVerifiers) {
            const matching = uniqueMutatedPaths.filter(p => verifier.filePatterns.some(pat => p.endsWith(pat)));
            const runArgs = verifier.perFile ? [...verifier.args, ...matching] : verifier.args;

            try {
              const res = await runVerificationCommand({
                command: verifier.command,
                args: runArgs,
                cwd: ".",
                timeout_ms: verifier.timeout_ms,
              });

              const outputObj = (res.output || {}) as Record<string, unknown>;
              const exitCode = typeof outputObj.exitCode === "number" ? outputObj.exitCode : (typeof outputObj.exit_code === "number" ? outputObj.exit_code : -1);
              const passed = res.success && (exitCode === 0 || outputObj.passed === true);
              const stdout = String(outputObj.stdout ?? "");
              const stderr = String(outputObj.stderr ?? "");

              if (passed) {
                state.verificationReceipts.push({
                  kind: "verification_result",
                  verification_kind: verifier.kind,
                  verifier_name: verifier.name,
                  command: `${verifier.command} ${runArgs.join(" ")}`,
                  passed: true,
                  exit_code: 0,
                  capturedAt: new Date().toISOString(),
                });
              } else {
                anyFailure = true;
                failureMessages.push(`[VERIFICATION FAILURE]
Verifier: ${verifier.name} (${verifier.kind})
Command: ${verifier.command} ${runArgs.join(" ")}
Exit Code: ${exitCode}

Stdout:
${stdout}

Stderr:
${stderr}`);

                state.verificationReceipts.push({
                  kind: "verification_result",
                  verification_kind: verifier.kind,
                  verifier_name: verifier.name,
                  command: `${verifier.command} ${runArgs.join(" ")}`,
                  passed: false,
                  exit_code: exitCode,
                  stdout,
                  stderr,
                  capturedAt: new Date().toISOString(),
                });
              }
            } catch (err) {
              anyFailure = true;
              failureMessages.push(`[VERIFICATION FAILURE]
Verifier: ${verifier.name} (${verifier.kind})
Command: ${verifier.command} ${runArgs.join(" ")}
Exit Code: -1

Stdout:
${(err as Error).message}

Stderr:
${(err as Error).stack ?? ""}`);

              state.verificationReceipts.push({
                kind: "verification_result",
                verification_kind: verifier.kind,
                verifier_name: verifier.name,
                command: `${verifier.command} ${runArgs.join(" ")}`,
                passed: false,
                exit_code: -1,
                error: (err as Error).message,
                capturedAt: new Date().toISOString(),
              });
            }
          }

          if (anyFailure) {
            state.rePlanDepth++;
            emitRePlan(state.correlation, {
              trigger: "verification_failure",
              step_index: state.stepIndex,
              convergence_depth: state.rePlanDepth,
            });

            const content = `Auto-verification failed. Please fix these verification failures before proceeding:

${failureMessages.join("\n\n")}

Please review the errors above, correct the code, and explain how you resolved the issues.`;

            state.messages.push({
              role: "user",
              content,
            });
          }
        }
      }

      if (mutatedPaths.length > 0) {
        await createCheckpoint(mutatedPaths, state.stepIndex, state.correlation).catch((err) => {
          log.warn(`[checkpoint] failed to create checkpoint: ${err.message}`);
        });
      }

      state.stepIndex += 1;
      continue;
    }

    if (shouldNudgeForCodeToolUse(state, llmResp)) {
      await appendCodeToolUseNudge(state, llmResp);
      state.stepIndex += 1;
      emitAuditEvent({
        trace_id: state.correlation.traceId,
        source_service: "mcp-server",
        kind: "agent_loop.code_tool_use_required",
        capability_id: state.correlation.capabilityId,
        severity: "warn",
        payload: {
          reason: "Developer stage returned a narrative response without tool calls; retrying with mandatory MCP tool-use instructions.",
          stepIndex: state.stepIndex,
          modelAlias: state.modelConfig.modelAlias,
          workspaceRoot: state.workspace?.workspaceRoot,
        },
      });
      continue;
    }

    return {
      kind: "complete",
      finalContent: llmResp.content,
      finishReason: llmResp.finish_reason as "stop" | "length" | "error",
    };
  }
  return { kind: "complete", finalContent: "", finishReason: "max_steps" };
}

async function pauseForApproval(
  state: LoopState,
  tc: ToolCall,
  desc?: PendingToolDescriptor,
  reason?: string,
  blockedToolInvocationId?: string,
): Promise<LoopOutcome> {
  // Pause: persist the loop state and return a WAITING_APPROVAL outcome.
  // Subsequent tool_calls in the same response are deferred until resume.
  const env = savePending({
    trace_id: state.correlation.traceId,
    mcp_invocation_id: state.correlation.mcpInvocationId,
    messages: state.messages,
    pending_tool_call: tc,
    pending_tool_descriptor: {
      name: tc.name,
      description: desc?.description ?? "",
      input_schema: desc?.input_schema ?? {},
      execution_target: desc?.execution_target ?? "LOCAL",
      version: desc?.version,
      risk_level: desc?.risk_level,
      requires_approval: desc?.requires_approval,
    },
    available_tools: state.availableTools,
    full_tool_descriptors: state.fullToolDescriptors,
    model_config: state.modelConfig,
    correlation: state.correlation,
    step_index: state.stepIndex,
    max_steps: state.maxSteps,
    max_tool_result_chars: state.maxToolResultChars,
    llm_call_ids: state.llmCallIds,
    tool_invocation_ids: state.toolInvocationIds,
    artifact_ids: state.artifactIds,
    code_change_ids: state.codeChangeIds,
    verification_receipts: state.verificationReceipts,
    prompt_cache_usage: state.promptCacheUsage,
    workspace: state.workspace,
    total_input_tokens: state.totalInputTokens,
    total_output_tokens: state.totalOutputTokens,
    total_estimated_cost: state.totalEstimatedCost,
    max_history_messages: state.maxHistoryMessages,
    max_history_tokens: state.maxHistoryTokens,
    compress_tool_results: state.compressToolResults,
    context_compression: state.contextCompression,
    governance_mode: state.governanceMode,
    context_plan_hash: state.contextPlanHash,
    degraded_actions_allowed: state.degradedActionsAllowed,
    allow_autonomous_mutation: state.allowAutonomousMutation,
    tool_use_nudge_count: state.toolUseNudgeCount,
    // M39 — persist PII token map across the approval pause. Only included
    // when the run has accumulated tokens (avoids serializing empty maps).
    pii_token_map: Object.keys(state.piiTokenMap).length > 0 ? state.piiTokenMap : undefined,
    re_plan_depth: state.rePlanDepth,
    breadcrumbs: state.breadcrumbs.length > 0 ? state.breadcrumbs : undefined,
  });
  const payload = {
    continuation_token: env.continuation_token,
    tool_name: tc.name,
    tool_args: tc.args,
    risk_level: desc?.risk_level,
    reason,
    blocked_tool_invocation_id: blockedToolInvocationId,
    governanceMode: state.governanceMode,
    contextPlanHash: state.contextPlanHash,
    expires_at: env.expires_at,
  };
  events.publish({
    kind: "approval.wait.created",
    correlation: { ...state.correlation },
    severity: "warn",
    payload,
  });
  await persistApproval(env, {
    capability_id: state.correlation.capabilityId,
    tool_name: tc.name,
    tool_args: tc.args ?? {},
    risk_level: desc?.risk_level,
  });
  emitAuditEvent({
    trace_id: state.correlation.traceId,
    source_service: "mcp-server",
    kind: "approval.wait.created",
    subject_type: "Approval",
    subject_id: env.continuation_token,
    capability_id: state.correlation.capabilityId,
    severity: "warn",
    payload,
  });
  return {
    kind: "paused",
    continuationToken: env.continuation_token,
    pendingToolCall: tc,
    pendingDescriptor: env.pending_tool_descriptor,
    finishReason: "approval_required",
  };
}

async function buildResponseBody(
  state: LoopState,
  outcome: LoopOutcome,
  startedAt: number,
): Promise<Record<string, unknown>> {
  let finalArtifactId: string | undefined;
  let finalContent = "";
  let formalFinishBlocked = false;

  if (outcome.kind !== "paused" && state.correlation.runId) {
    await cleanupCheckpoints(state.correlation.runId).catch((err) => {
      log.warn(`[checkpoint] cleanup failed: ${err.message}`);
    });
  }

  if (outcome.kind === "complete") {
    if (state.workspace?.branch) {
      const finish = await finishWorkBranch(
        `Singularity work item ${state.correlation.workItemId ?? state.workspace.branch.branch}`,
        {
          push: config.MCP_WORK_BRANCH_PUSH_ON_FINISH,
          remote: config.MCP_WORK_BRANCH_PUSH_REMOTE,
          verificationReceipts: state.verificationReceipts,
        },
      );
      const stats = await indexWorkspace("auto_finish");
      state.workspace.commitSha = finish.commitSha;
      state.workspace.changedPaths = finish.changedPaths;
      state.workspace.workspaceRoot = finish.workspaceRoot ?? state.workspace.workspaceRoot ?? sandboxRoot();
      state.workspace.astIndexStatus = stats.status;
      state.workspace.astIndexedFiles = stats.indexedFiles;
      state.workspace.astIndexedSymbols = stats.indexedSymbols;
      if (finish.formalVerification) state.verificationReceipts.push({ ...finish.formalVerification });
      if (finish.formalVerificationBlocked) {
        formalFinishBlocked = true;
        const feedback = {
          status: "formal_verification_blocked",
          message: finish.message,
          changedPaths: finish.changedPaths,
          formalVerification: finish.formalVerification,
        };
        if (!state.workspace.formalRepairAttempted && state.stepIndex < state.maxSteps) {
          state.workspace.formalRepairAttempted = true;
          state.messages.push({
            role: "user",
            content: [
              "Automatic branch finish was blocked by formal verification.",
              "Use the verifier output below as repair feedback. Inspect and edit the workspace, run verification again, then finish the branch.",
              JSON.stringify(feedback, null, 2),
            ].join("\n\n"),
          });
          state.stepIndex += 1;
          const repairedOutcome = await runLoop(state);
          return buildResponseBody(state, repairedOutcome, startedAt);
        }
        finalContent = [
          "Formal verification blocked branch finish.",
          finish.formalVerification?.explanation,
          finish.formalVerification?.counterexample ? `Counterexample: ${JSON.stringify(finish.formalVerification.counterexample)}` : undefined,
          finish.formalVerification?.recommendations ? `Recommendations: ${JSON.stringify(finish.formalVerification.recommendations)}` : undefined,
        ].filter(Boolean).join("\n");
      }
      if (finish.committed && finish.commitSha) {
        const codeChange = recordCodeChange({
          correlation: { ...state.correlation },
          paths_touched: finish.changedPaths,
          patch: finish.patch,
          commit_sha: finish.commitSha,
          tool_name: "finish_work_branch_auto",
          source: "heuristic",
          metadata: {
            branch: finish.branch,
            message: finish.message,
            workspaceRoot: finish.workspaceRoot,
            pushed: finish.pushed,
            pushError: finish.pushError,
            remote: config.MCP_WORK_BRANCH_PUSH_ON_FINISH ? config.MCP_WORK_BRANCH_PUSH_REMOTE : undefined,
          },
        });
        state.codeChangeIds.push(codeChange.id);
        events.publish({
          kind: "code_change.detected",
          correlation: { ...state.correlation, artifactId: codeChange.id },
          payload: {
            code_change_id: codeChange.id,
            tool_name: codeChange.tool_name,
            paths_touched: codeChange.paths_touched,
            has_patch: Boolean(codeChange.patch),
            has_commit: true,
            source: codeChange.source,
          },
        });
        events.publish({
          kind: "git.commit.created",
          correlation: { ...state.correlation, artifactId: codeChange.id },
          payload: {
            code_change_id: codeChange.id,
            branch: finish.branch,
            commit_sha: finish.commitSha,
            paths_touched: finish.changedPaths,
          },
        });
      }
    }
    finalContent = finalContent || outcome.finalContent;
    if (finalContent) {
      const art = recordArtifact({
        correlation: state.correlation,
        artifact_type: "TEXT",
        label: "final_response",
        content: finalContent,
      });
      state.artifactIds.push(art.id);
      finalArtifactId = art.id;
      events.publish({
        kind: "artifact.created",
        correlation: { ...state.correlation, artifactId: art.id },
        payload: {
          artifact_type: "TEXT",
          label: "final_response",
          size_chars: finalContent.length,
        },
      });
    }
  }

  events.publish({
    kind: "run.event",
    correlation: { ...state.correlation },
    payload: {
      phase: outcome.kind === "paused" ? "waiting_approval"
           : outcome.kind === "denied" ? (outcome.finishReason === "agent_loop_repetition" ? "agent_loop_repetition" : "governance_denied")
           : "complete",
      finishReason: outcome.finishReason,
      stepsTaken: state.stepIndex,
      llmCalls: state.llmCallIds.length,
      toolInvocations: state.toolInvocationIds.length,
      estimated_cost: state.totalEstimatedCost,
      contextCompression: state.contextCompression,
      promptCache: promptCacheSummary(state),
      latency_ms: Date.now() - startedAt,
    },
  });

  log.info(
    {
      mcpInvocationId: state.correlation.mcpInvocationId,
      traceId: state.correlation.traceId,
      steps: state.stepIndex,
      llmCalls: state.llmCallIds.length,
      toolInvocations: state.toolInvocationIds.length,
      finishReason: outcome.finishReason,
      kind: outcome.kind,
    },
    "agent loop finished",
  );

  const status =
    outcome.kind === "paused" ? "WAITING_APPROVAL"
    : outcome.kind === "denied" ? "DENIED"
    : formalFinishBlocked ? "FAILED"
    : outcome.finishReason === "max_steps" ? "FAILED"
    : "COMPLETED";

  const promptCache = promptCacheSummary(state);
  const correlationOut: Record<string, unknown> = {
    mcpInvocationId: state.correlation.mcpInvocationId,
    traceId: state.correlation.traceId,
    modelAlias: state.modelConfig.modelAlias,
    governanceMode: state.governanceMode,
    contextPlanHash: state.contextPlanHash,
    llmCallIds: state.llmCallIds,
    toolInvocationIds: state.toolInvocationIds,
    artifactIds: state.artifactIds,
    codeChangeIds: state.codeChangeIds,
    verificationReceipts: state.verificationReceipts,
    promptCache,
    finalArtifactId,
  };

  const out: Record<string, unknown> = {
    status,
    finalResponse: finalContent,
    finishReason: outcome.finishReason,
    stepsTaken: state.stepIndex,
    correlation: correlationOut,
    tokensUsed: {
      input: state.totalInputTokens,
      output: state.totalOutputTokens,
      total: state.totalInputTokens + state.totalOutputTokens,
      estimatedCost: state.totalEstimatedCost,
      estimated_cost: state.totalEstimatedCost,
      promptCache,
    },
    modelUsage: {
      modelAlias: state.modelConfig.modelAlias,
      provider: state.modelConfig.provider,
      model: state.modelConfig.model,
      warnings: state.modelConfig.warnings ?? [],
      inputTokens: state.totalInputTokens,
      outputTokens: state.totalOutputTokens,
      totalTokens: state.totalInputTokens + state.totalOutputTokens,
      estimatedCost: state.totalEstimatedCost,
      promptCache,
    },
    promptCache,
    contextCompression: state.contextCompression,
    governance: {
      mode: state.governanceMode,
      contextPlanHash: state.contextPlanHash,
      executionPosture: outcome.kind === "denied" ? "blocked" : state.governanceMode === "degraded" ? "degraded" : "full",
      degradedActionsAllowed: state.degradedActionsAllowed,
    },
    workspace: {
      workspaceRoot: state.workspace?.workspaceRoot ?? sandboxRoot(),
      workspaceBranch: state.workspace?.branch?.branch,
      workspaceCommitSha: state.workspace?.commitSha,
      changedPaths: state.workspace?.changedPaths ?? [],
      astIndexStatus: state.workspace?.astIndexStatus ?? lastAstStats()?.status,
      astIndexedFiles: state.workspace?.astIndexedFiles ?? lastAstStats()?.indexedFiles,
      astIndexedSymbols: state.workspace?.astIndexedSymbols ?? lastAstStats()?.indexedSymbols,
      source: state.workspace?.source,
    },
    verificationReceipts: state.verificationReceipts,
  };

  if (outcome.kind === "paused") {
    out.pendingApproval = {
      continuation_token: outcome.continuationToken,
      tool_name: outcome.pendingToolCall.name,
      tool_args: outcome.pendingToolCall.args,
      tool_descriptor: outcome.pendingDescriptor,
    };
    (correlationOut as Record<string, unknown>).continuationToken = outcome.continuationToken;
  }

  if (outcome.kind === "denied") {
    out.governance = {
      ...(out.governance as Record<string, unknown>),
      check: outcome.check,
      reason: outcome.reason,
      details: outcome.details,
    };
  }

  return out;
}

// ── POST /mcp/invoke ─────────────────────────────────────────────────────

// M26 — extracted so the laptop relay-client can reuse the exact same logic
// without going through Express. Parses + validates + runs the loop + builds
// the response body. Throws AppError on bad input.
export async function executeInvokePayload(rawBody: unknown): Promise<Record<string, unknown>> {
  const parsed = InvokeSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new AppError("invalid /mcp/invoke payload", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }
  const body = parsed.data;
  const startedAt = Date.now();
  const workspaceRoot = workspaceRootForRunContext({
    workItemId: body.runContext.workItemId,
    workItemCode: body.runContext.workItemCode,
    branchName: body.runContext.branchName,
    workspaceRoot: body.runContext.workspaceRoot,
  });

  return await withSandboxRoot(workspaceRoot, async () => withWorkspaceLock(async () => {
  await gcWorkItemWorkspaces().catch((err) => {
    log.warn({ err: (err as Error).message }, "[mcp-server] workspace GC failed");
  });
  const correlation: CorrelationIds = {
    ...body.runContext,
    runId: body.runContext.runId ?? body.runContext.workflowInstanceId,
    runStepId: body.runContext.runStepId ?? body.runContext.nodeId,
    workItemId: body.runContext.workItemId,
    mcpInvocationId: uuidv4(),
  };

  const source = await ensureWorkspaceSource({
    sourceType: body.runContext.sourceType,
    sourceUri: body.runContext.sourceUri,
    sourceRef: body.runContext.sourceRef,
  }, correlation);

  const branchRequest = {
    workflowInstanceId: body.runContext.workflowInstanceId ?? body.runContext.runId,
    nodeId: body.runContext.nodeId ?? body.runContext.runStepId,
    workItemId: body.runContext.workItemId,
    workItemCode: body.runContext.workItemCode,
    branchBase: body.runContext.branchBase,
    branchName: body.runContext.branchName,
  };
  const branch = branchNameForWork(branchRequest)
    ? await prepareWorkBranch(branchRequest, correlation)
    : null;
  const astStats = branch ? await indexWorkspace("branch_start") : await indexWorkspace("invoke_start");

  const mergedTools = new Map<string, typeof body.tools[number]>();
  for (const tool of body.tools) mergedTools.set(tool.name, tool);
  if (body.limits.includeLocalTools !== false) {
    for (const tool of listLocalTools()) {
      if (mergedTools.has(tool.name)) continue;
      mergedTools.set(tool.name, {
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        execution_target: "LOCAL",
        natural_language: tool.natural_language,
        risk_level: tool.risk_level,
        requires_approval: tool.requires_approval,
        // M39 — local-registry tools opt-in to PII masking via their descriptor.
        pii_sensitive: (tool as { pii_sensitive?: boolean }).pii_sensitive,
      });
    }
  }
  const toolList = Array.from(mergedTools.values());

  const messages: ChatMessage[] = [];
  if (body.systemPrompt) messages.push({ role: "system", content: body.systemPrompt });
  // M36.3 — the "Local code intelligence policy" and "Developer stage tool
  // policy" system messages used to be injected here, gated by tool-name
  // pattern matching. They now live in prompt-composer as TOOL_CONTRACT
  // layers (Local Code Intelligence Tool Policy, Developer Code-Mutation
  // Tool Policy) attached to the right stage profiles. mcp-server is now
  // a pure tool runner: it does not decorate the prompt with policy text.
  // The caller (context-fabric, via composer) is the single source of
  // truth for the system prompt content.
  for (const h of body.history) messages.push({ ...h });
  messages.push({ role: "user", content: body.message });

  const availableTools: ToolDescriptorForLlm[] = toolList.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  const fullToolDescriptors: PendingToolDescriptor[] = toolList.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    execution_target: t.execution_target,
    natural_language: t.natural_language,
    risk_level: t.risk_level,
    requires_approval: t.requires_approval,
    // M39 — carry pii_sensitive into the loop state so the splice points
    // can decide whether to mask this tool's output.
    pii_sensitive: (t as { pii_sensitive?: boolean }).pii_sensitive,
  }));

  const resolvedModel: LoopState["modelConfig"] = {
    ...resolveModelConfig({
      modelAlias: body.modelConfig.modelAlias,
      provider: body.modelConfig.provider,
      model: body.modelConfig.model,
      temperature: body.modelConfig.temperature,
      maxTokens: body.modelConfig.maxTokens,
    }),
    applierModelAlias: body.modelConfig.applierModelAlias,
    promptCache: normalizePromptCache(body.modelConfig.promptCache, messages, availableTools),
  };

  const state: LoopState = {
    messages,
    availableTools,
    fullToolDescriptors,
    modelConfig: resolvedModel,
    correlation,
    stepIndex: 0,
    maxSteps: body.limits.maxSteps ?? config.MAX_AGENT_STEPS,
    maxToolResultChars: body.limits.maxToolResultChars,
    maxHistoryMessages: body.limits.maxHistoryMessages,
    maxHistoryTokens: body.limits.maxHistoryTokens,
    compressToolResults: body.limits.compressToolResults === true,
    llmCallIds: [],
    toolInvocationIds: [],
    artifactIds: [],
    codeChangeIds: [],
    verificationReceipts: [],
    promptCacheUsage: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    contextCompression: {
      messagesDropped: 0,
      tokensDropped: 0,
      toolResultsCompressed: 0,
      toolResultBytesSaved: 0,
    },
    toolCallHistory: [],
    toolUseNudgeCount: 0,
    workspace: {
      branch,
      workspaceRoot: sandboxRoot(),
      source,
      astIndexStatus: astStats.status,
      astIndexedFiles: astStats.indexedFiles,
      astIndexedSymbols: astStats.indexedSymbols,
    },
    governanceMode: body.governanceMode,
    contextPlanHash: body.contextPlanHash,
    degradedActionsAllowed: body.degradedActionsAllowed ?? [],
    allowAutonomousMutation: body.allowAutonomousMutation === true,
    // M39 — fresh PII token map per run (populated lazily on first masked output)
    piiTokenMap: {},
    rePlanDepth: (body.runContext.dependencyState?.changed_paths?.length ?? 0) > 0 ? 1 : 0,
    breadcrumbs: [],
  };

  if (state.rePlanDepth > 0) {
    emitRePlan(state.correlation, {
      trigger: "dependency_stale",
      step_index: 0,
      convergence_depth: state.rePlanDepth,
      conflicted_paths: body.runContext.dependencyState?.changed_paths,
    });
  }

  const outcome = await runLoop(state);
  return buildResponseBody(state, outcome, startedAt);
  }));
}

invokeRouter.post("/invoke", async (req, res) => {
  const data = await executeInvokePayload(req.body);
  res.json({
    success: true,
    data,
    requestId: res.locals.requestId,
  });
});

// ── POST /mcp/resume ─────────────────────────────────────────────────────

invokeRouter.post("/resume", async (req, res) => {
  const parsed = ResumeSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError("invalid /mcp/resume payload", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }
  const body = parsed.data;
  const startedAt = Date.now();

  // M35.2 — Verify continuation token signature and reject replays
  const pendingResult = takePending(body.continuation_token);
  if (!pendingResult.ok) {
    // M35.2 — Emit audit event for replay attempts or other token failures
    if (pendingResult.reason === "replay_attempt") {
      emitAuditEvent({
        trace_id: req.body.trace_id,
        source_service: "mcp-server",
        kind: "audit.replay_attempt_rejected",
        severity: "warn",
        payload: { continuation_token: body.continuation_token, reason: pendingResult.reason },
      });
    }
    // Map token verification failures to HTTP status codes
    const statusCode = pendingResult.reason === "replay_attempt" ? 410 // Gone
                     : pendingResult.reason === "expired_token" ? 410   // Gone
                     : pendingResult.reason === "invalid_signature" ? 401 // Unauthorized
                     : 404; // not_found
    throw new AppError(
      `continuation_token verification failed: ${pendingResult.reason}`,
      statusCode,
      "CONTINUATION_TOKEN_INVALID",
    );
  }
  let env = pendingResult.approval;

  // M21.5 — try in-memory first (hot path, same instance), fall through to
  // audit-gov on miss so a restarted mcp-server can still resume the run.
  // /consume is single-use atomic: the audit-gov row flips to 'consumed' on
  // first call, so concurrent resumers can't both succeed.
  if (!env) {
    const consumed = await consumeApproval(body.continuation_token);
    if (consumed && consumed.payload) {
      env = consumed.payload;
      // Trust audit-gov's decision over the request body if they disagree
      // (operator may have changed mind between /decide and /resume).
      if (body.decision !== consumed.decision) {
        log.warn({ token: body.continuation_token, sent: body.decision, audit: consumed.decision },
          "[mcp-server] /mcp/resume decision arg differs from audit-gov; using audit-gov");
        body.decision = consumed.decision;
        if (consumed.decision_reason) body.reason = consumed.decision_reason;
      }
    }
  }
  if (!env) throw new NotFoundError(`continuation_token not found or already consumed: ${body.continuation_token}`);

  const resumeWorkspaceRoot = env.workspace?.workspaceRoot
    ?? env.workspace?.branch?.workspaceRoot
    ?? workspaceRootForRunContext({
      workItemId: env.correlation.workItemId,
      branchName: env.workspace?.branch?.branch,
    });
  await withSandboxRoot(resumeWorkspaceRoot, async () => withWorkspaceLock(async () => {
  const state: LoopState = {
    messages: env.messages,
    availableTools: env.available_tools,
    fullToolDescriptors: env.full_tool_descriptors,
    modelConfig: env.model_config,
    correlation: env.correlation,
    stepIndex: env.step_index,
    maxSteps: env.max_steps,
    maxToolResultChars: env.max_tool_result_chars,
    maxHistoryMessages: env.max_history_messages,
    maxHistoryTokens: env.max_history_tokens,
    compressToolResults: env.compress_tool_results === true,
    llmCallIds: env.llm_call_ids,
    toolInvocationIds: env.tool_invocation_ids,
    artifactIds: env.artifact_ids,
    codeChangeIds: env.code_change_ids ?? [],
    verificationReceipts: env.verification_receipts ?? [],
    promptCacheUsage: env.prompt_cache_usage ?? [],
    // Resumed loops start with a fresh history — the repetition detector
    // only meaningfully fires on consecutive identical calls within a single
    // invocation, not across approval pauses.
    toolCallHistory: [],
    toolUseNudgeCount: env.tool_use_nudge_count ?? 0,
    workspace: env.workspace,
    totalInputTokens: env.total_input_tokens,
    totalOutputTokens: env.total_output_tokens,
    totalEstimatedCost: env.total_estimated_cost ?? 0,
    contextCompression: env.context_compression ?? {
      messagesDropped: 0,
      tokensDropped: 0,
      toolResultsCompressed: 0,
      toolResultBytesSaved: 0,
    },
    governanceMode: env.governance_mode ?? "fail_open",
    contextPlanHash: env.context_plan_hash,
    degradedActionsAllowed: env.degraded_actions_allowed ?? [],
    allowAutonomousMutation: env.allow_autonomous_mutation === true,
    // M39 — restore the run's PII token map across the approval pause.
    // The HMAC-signed PendingApproval envelope (M35.2) guarantees the map
    // hasn't been tampered with between save + resume.
    piiTokenMap: env.pii_token_map ?? {},
    rePlanDepth: env.re_plan_depth ?? 0,
    breadcrumbs: env.breadcrumbs ?? [],
  };
  state.workspace = {
    ...(state.workspace ?? {}),
    workspaceRoot: state.workspace?.workspaceRoot ?? sandboxRoot(),
  };

  // M27.5 — re-establish the persisted work-branch on disk before resuming
  // the loop. Without this, an mcp-server restart between /pause and
  // /resume would leave HEAD on whatever branch the process woke up on
  // (often `main`), and the subsequent tool dispatches + finishWorkBranch
  // would commit to the wrong branch. The persisted envelope already
  // carries `workspace.branch` (branch name, baseBranch, captured headSha)
  // so we just need to checkout the branch and refresh the live headSha.
  if (env.workspace?.branch) {
    try {
      const restored = await restoreWorkBranch(env.workspace.branch, state.correlation);
      if (restored && state.workspace) {
        state.workspace.branch = restored;
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, token: body.continuation_token },
        "[mcp-server] /mcp/resume could not restore work-branch; continuing on current HEAD");
    }
  }

  const tc = env.pending_tool_call;
  // M39 — un-mask any PII tokens in the args before dispatch so the
  // downstream enterprise API receives real values. tc.args + args_override
  // come from the LLM's tool_call (which only sees masked tokens).
  const rawArgs = body.args_override ?? tc.args;
  const args = applyArgsUnmaskIfNeeded(state, rawArgs);

  events.publish({
    kind: "approval.wait.resolved",
    correlation: { ...state.correlation },
    severity: body.decision === "approved" ? "info" : "warn",
    payload: {
      continuation_token: body.continuation_token,
      decision: body.decision,
      reason: body.reason,
      tool_name: tc.name,
    },
  });

  if (body.decision === "rejected") {
    // Append a tool_result that records the rejection so the LLM gets to react.
    state.messages.push({
      role: "tool",
      content: toolResultForNextTurn(state, {
        status: "approval_rejected",
        reason: body.reason ?? "operator rejected the request",
      }),
      tool_call_id: tc.id,
      tool_name: tc.name,
    });
  } else {
    // Approved — execute the tool and append the result.
    if (tc.name === "finish_work_branch") {
      args.verificationReceipts = state.verificationReceipts;
    }
    const result = await dispatchToolCall(
      { ...tc, args },
      env.full_tool_descriptors.map((d) => ({
        ...d,
        // Bypass the requires_approval gate on this single dispatch:
        // approval already happened.
        requires_approval: false,
      })) as never,
      state.correlation,
      body.continuation_token,
      state.workspace?.workspaceRoot,
    );
    state.toolInvocationIds.push(result.record.id);
    if (result.codeChange) state.codeChangeIds.push(result.codeChange.id);
    state.verificationReceipts.push(...verificationReceiptsFromOutput(result.record.output, result.record.id, tc.name));
    // M39 / M39.B — mask resumed-tool output (async path for NER support).
    const resumeDesc = env.full_tool_descriptors.find((d) => d.name === tc.name);
    const rawOutput = toolResultForNextTurn(state, result.record.output);
    state.messages.push({
      role: "tool",
      content: await applyOutputMaskIfNeededAsync(state, resumeDesc, rawOutput),
      tool_call_id: tc.id,
      tool_name: tc.name,
    });
  }
  state.stepIndex += 1;

  const outcome = await runLoop(state);
  res.json({
    success: true,
    data: await buildResponseBody(state, outcome, startedAt),
    requestId: res.locals.requestId,
  });
  }));
});

function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function estimateLoopInputTokens(state: LoopState): number {
  const messageTokens = state.messages.reduce((sum, msg) => sum + estimateTextTokens(msg.content), 0);
  const toolTokens = state.availableTools.reduce(
    (sum, tool) => sum + estimateTextTokens(`${tool.name}\n${tool.description}\n${JSON.stringify(tool.input_schema ?? {})}`),
    0,
  );
  return messageTokens + toolTokens + (state.modelConfig.maxTokens ?? 0);
}

function normalizePromptCache(
  requested: { enabled?: boolean; strategy?: string; key?: string } | undefined,
  messages: ChatMessage[],
  tools: ToolDescriptorForLlm[],
): LoopState["modelConfig"]["promptCache"] | undefined {
  if (requested?.enabled !== true) return undefined;
  const stablePrefix = JSON.stringify({
    system: messages.filter((msg) => msg.role === "system").map((msg) => msg.content),
    tools: tools.map((tool) => ({ name: tool.name, schema: tool.input_schema })),
  });
  return {
    enabled: true,
    strategy: requested.strategy ?? "provider_auto",
    key: requested.key?.trim() || createHash("sha256").update(stablePrefix).digest("hex").slice(0, 24),
  };
}

function promptCacheNumber(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function promptCacheSummary(state: LoopState): Record<string, unknown> {
  const usage = state.promptCacheUsage;
  const requested = state.modelConfig.promptCache;
  const cacheReadTokens = usage.reduce((sum, item) => sum + promptCacheNumber(item, [
    "read_tokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cached_input_tokens",
    "cachedInputTokens",
  ]), 0);
  const cacheWriteTokens = usage.reduce((sum, item) => sum + promptCacheNumber(item, [
    "write_tokens",
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_write_input_tokens",
    "cacheWriteInputTokens",
  ]), 0);
  const savingsEstimatedTokens = usage.reduce((sum, item) => sum + promptCacheNumber(item, [
    "savings_estimated_tokens",
    "savingsEstimatedTokens",
    "tokens_saved",
    "tokensSaved",
  ]), 0);
  const hitCount = usage.filter((item) => item.hit === true || item.cache_hit === true || item.cacheHit === true).length;
  const missCount = usage.filter((item) => item.hit === false || item.cache_hit === false || item.cacheHit === false).length;

  return {
    enabled: requested?.enabled === true,
    strategy: requested?.strategy,
    key: requested?.key,
    requested,
    reported: usage.some((item) => item.reported !== false),
    hitCount,
    missCount,
    cacheReadTokens,
    cacheWriteTokens,
    savingsEstimatedTokens: savingsEstimatedTokens > 0 ? savingsEstimatedTokens : undefined,
    usage,
  };
}

const BREADCRUMB_PREFIX = "[Compressed run history — earlier tool exchanges, summarized to save context]";
const MAX_BREADCRUMB_LINES = 40;

function isBreadcrumbMessage(msg: ChatMessage): boolean {
  return msg.role === "user" && typeof msg.content === "string" && msg.content.startsWith(BREADCRUMB_PREFIX);
}

function briefValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.length > 60 ? v.slice(0, 57) + "..." : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + "..." : s;
  } catch { return String(v).slice(0, 60); }
}

function briefArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args).slice(0, 3).map(([k, v]) => `${k}=${briefValue(v)}`).join(", ");
}

function briefToolResult(content: string | undefined): string {
  if (!content) return "ok";
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      if ("error" in parsed && parsed.error) return `error: ${briefValue(parsed.error)}`;
      if ("error_code" in parsed && parsed.error_code) return `error: ${briefValue(parsed.error_code)}`;
      if (Array.isArray(parsed)) return `${parsed.length} items`;
      if (typeof parsed.lines === "number") return `${parsed.lines} lines`;
      if (typeof parsed.match_count === "number") return `${parsed.match_count} matches`;
      if (Array.isArray(parsed.matches)) return `${parsed.matches.length} matches`;
      if (Array.isArray(parsed.results)) return `${parsed.results.length} results`;
      if (typeof parsed.path === "string") return `ok (${parsed.path})`;
      if (parsed.success === false) return "failed";
      if (parsed.success === true) return "ok";
    }
  } catch { /* not JSON; fall through */ }
  return `${content.length} bytes`;
}

function formatBreadcrumbLine(asst: ChatMessage, next: ChatMessage | undefined): string | null {
  try {
    const parsed = JSON.parse(asst.content || "{}");
    if (parsed && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      const calls = parsed.tool_calls.map((c: { name?: string; args?: Record<string, unknown> }) =>
        `${c.name ?? "?"}(${briefArgs(c.args)})`,
      ).join(", ");
      const result = next?.role === "tool" ? briefToolResult(next.content) : "...";
      return `- ${calls} → ${result}`;
    }
  } catch { /* not a tool_call payload */ }
  return null;
}

function buildBreadcrumbMessage(lines: string[]): ChatMessage {
  return { role: "user", content: `${BREADCRUMB_PREFIX}\n${lines.join("\n")}` };
}

function applySlidingWindow(state: LoopState): void {
  if (!state.maxHistoryMessages && !state.maxHistoryTokens) return;

  const beforeMessages = state.messages.length;
  const beforeTokens = state.messages.reduce((sum, msg) => sum + estimateTextTokens(msg.content), 0);
  const systemMessages = state.messages.filter((msg) => msg.role === "system");
  const nonSystem = state.messages.filter((msg) => msg.role !== "system");

  // Strip the existing breadcrumb message (if any) so it isn't counted as
  // rolling history — it gets re-emitted from state.breadcrumbs below.
  const candidates = nonSystem.filter((m) => !isBreadcrumbMessage(m));

  // Pin the first user message (the original task) as an anchor — without it
  // the agent loses its goal after a few tool exchanges and wastes steps
  // re-exploring context, eventually hitting max_steps.
  const anchorIdx = candidates.findIndex((m) => m.role === "user");
  const anchorMessage = anchorIdx >= 0 ? candidates[anchorIdx] : null;
  let rollingMessages = anchorMessage
    ? candidates.filter((_, i) => i !== anchorIdx)
    : candidates;

  // Always strip leading orphan tool messages from rolling. A tool message
  // without a preceding assistant tool_use produces an Anthropic 400:
  // "tool_result block must have a corresponding tool_use". Once we pin
  // anchor + breadcrumb (both user role) ahead of rolling, Anthropic merges
  // consecutive user messages and any leading tool_result becomes an
  // orphan content block in message 0. Unconditional — applies even when
  // no trim happened — because rolling can start with a tool message via
  // context-fabric history or via the resume path. If this empties rolling,
  // that's fine: anchor + breadcrumb still constitute a valid first message.
  rollingMessages = dropLeadingOrphanToolMessages(rollingMessages);

  if (state.maxHistoryMessages) {
    // Reserve slots for the pinned anchor + breadcrumb so they don't eat the rolling budget.
    const willHaveBreadcrumb = state.breadcrumbs.length > 0 || rollingMessages.length > state.maxHistoryMessages;
    const reserved = (anchorMessage ? 1 : 0) + (willHaveBreadcrumb ? 1 : 0);
    const rollingCap = Math.max(1, state.maxHistoryMessages - reserved);
    if (rollingMessages.length > rollingCap) {
      rollingMessages = dropLeadingOrphanToolMessages(rollingMessages.slice(-rollingCap));
    }
  }

  if (state.maxHistoryTokens) {
    const anchorArr = anchorMessage ? [anchorMessage] : [];
    const tentativeBreadcrumb = state.breadcrumbs.length > 0 ? [buildBreadcrumbMessage(state.breadcrumbs)] : [];
    let combined = [...systemMessages, ...anchorArr, ...tentativeBreadcrumb, ...rollingMessages];
    while (rollingMessages.length > 1 && estimateLoopInputTokens({ ...state, messages: combined }) > state.maxHistoryTokens) {
      const candidate = dropLeadingOrphanToolMessages(rollingMessages.slice(1));
      if (candidate.length === rollingMessages.length) break; // no progress
      rollingMessages = candidate;
      combined = [...systemMessages, ...anchorArr, ...tentativeBreadcrumb, ...rollingMessages];
    }
  }

  // Defense-in-depth: scan rolling for *mid-sequence* orphan tool messages
  // (tool_result whose tool_use_id isn't emitted by an earlier assistant
  // turn in this rolling window). These can leak in via context-fabric
  // history or after re-plan paths. Anthropic rejects them just as hard.
  rollingMessages = removeOrphanedToolResults(rollingMessages);

  // Compute which non-pinned messages got dropped this pass and breadcrumb them.
  const survivingSet = new Set<ChatMessage>([
    ...(anchorMessage ? [anchorMessage] : []),
    ...rollingMessages,
  ]);
  const droppedCandidates = candidates.filter((m) => !survivingSet.has(m));
  if (droppedCandidates.length > 0) {
    const newLines: string[] = [];
    for (let i = 0; i < droppedCandidates.length; i++) {
      const cur = droppedCandidates[i];
      const next = droppedCandidates[i + 1];
      if (cur.role === "assistant") {
        const line = formatBreadcrumbLine(cur, next);
        if (line) newLines.push(line);
      } else if (cur.role === "user") {
        // Non-anchor user messages (e.g. auto-verification failure feedback)
        const preview = (cur.content || "").replace(/\s+/g, " ").slice(0, 100);
        const ell = (cur.content || "").length > 100 ? "..." : "";
        newLines.push(`- user feedback: "${preview}${ell}"`);
      }
      // tool messages are consumed via the preceding assistant entry; skip standalone.
    }
    if (newLines.length > 0) {
      state.breadcrumbs = [...state.breadcrumbs, ...newLines].slice(-MAX_BREADCRUMB_LINES);
    }
  }

  const finalBreadcrumb = state.breadcrumbs.length > 0 ? buildBreadcrumbMessage(state.breadcrumbs) : null;
  state.messages = [
    ...systemMessages,
    ...(anchorMessage ? [anchorMessage] : []),
    ...(finalBreadcrumb ? [finalBreadcrumb] : []),
    ...rollingMessages,
  ];
  const afterTokens = state.messages.reduce((sum, msg) => sum + estimateTextTokens(msg.content), 0);
  const dropped = Math.max(0, beforeMessages - state.messages.length);
  if (dropped > 0) {
    state.contextCompression.messagesDropped += dropped;
    state.contextCompression.tokensDropped += Math.max(0, beforeTokens - afterTokens);
  }
}

function dropLeadingOrphanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  let start = 0;
  while (start < messages.length && messages[start].role === "tool") start += 1;
  return start > 0 ? messages.slice(start) : messages;
}

/**
 * Remove tool_result messages whose `tool_call_id` doesn't match any
 * tool_use ID emitted by an earlier assistant message in the same window.
 *
 * Anthropic rejects orphan tool_results with HTTP 400:
 *   "tool_result block must have a corresponding tool_use block".
 *
 * Orphans can appear mid-sequence after sliding-window trims drop the
 * assistant turn that originally produced them, or when context-fabric
 * history is itself misaligned. Stripping them is always safe — the
 * assistant call they referenced is no longer in scope anyway.
 */
function removeOrphanedToolResults(messages: ChatMessage[]): ChatMessage[] {
  const knownIds = new Set<string>();
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      try {
        const parsed = JSON.parse(msg.content || "{}");
        if (parsed && Array.isArray(parsed.tool_calls)) {
          for (const c of parsed.tool_calls) {
            if (c && typeof c.id === "string") knownIds.add(c.id);
          }
        }
      } catch { /* assistant without tool_calls JSON — ignore */ }
      out.push(msg);
      continue;
    }
    if (msg.role === "tool") {
      const id = msg.tool_call_id;
      if (typeof id === "string" && knownIds.has(id)) {
        out.push(msg);
      }
      // else: orphan — drop silently. Re-emitting it as a breadcrumb is
      // not useful because the original assistant call is also gone.
      continue;
    }
    out.push(msg);
  }
  return out;
}

function toolResultForNextTurn(state: LoopState, output: unknown): string {
  const raw = JSON.stringify(output);
  if (!state.compressToolResults) return trimToolResult(raw, state.maxToolResultChars);

  const compressed = JSON.stringify(compactToolResult(output));
  const selected = compressed.length < raw.length ? compressed : raw;
  if (selected.length < raw.length) {
    state.contextCompression.toolResultsCompressed += 1;
    state.contextCompression.toolResultBytesSaved += raw.length - selected.length;
  }
  return trimToolResult(selected, state.maxToolResultChars);
}

function compactToolResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length <= 8) return value.map(compactToolResult);
    return {
      kind: "compressed_array",
      length: value.length,
      sample: value.slice(0, 5).map(compactToolResult),
    };
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.length > 2000) {
      return {
        kind: "compressed_text",
        chars: value.length,
        excerpt: value.slice(0, 1200),
      };
    }
    return value;
  }

  const obj = value as Record<string, unknown>;
  if (obj.kind === "code_change") {
    return {
      kind: obj.kind,
      paths_touched: obj.paths_touched,
      lines_added: obj.lines_added,
      lines_removed: obj.lines_removed,
      commit_sha: obj.commit_sha,
      patch_chars: typeof obj.patch === "string" ? obj.patch.length : undefined,
      diff_chars: typeof obj.diff === "string" ? obj.diff.length : undefined,
    };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(obj)) {
    if ((key === "content" || key === "body" || key === "text") && typeof item === "string" && item.length > 2000) {
      out[key] = { kind: "compressed_text", chars: item.length, excerpt: item.slice(0, 1200) };
    } else if ((key === "patch" || key === "diff") && typeof item === "string" && item.length > 2000) {
      out[`${key}_chars`] = item.length;
    } else {
      out[key] = compactToolResult(item);
    }
  }
  return out;
}

function trimToolResult(content: string, maxChars?: number): string {
  if (!maxChars || content.length <= maxChars) return content;
  return `${content.slice(0, Math.max(0, maxChars - 80))}\n...[tool result trimmed to ${maxChars} chars]`;
}

// ── M39 — PII masking splice helpers ─────────────────────────────────────
//
// All tool-output → message paths funnel through applyOutputMaskIfNeeded().
// All tool-args → dispatch paths funnel through applyArgsUnmaskIfNeeded().
// Both are no-ops when masking is disabled (the default for tools without
// pii_sensitive=true unless the env opt-in is set).

function piiMaskingEnabled(_state: LoopState, desc?: PendingToolDescriptor): boolean {
  if (process.env.MCP_PII_MASK_ENABLED === "false") return false; // kill switch
  if (desc?.pii_sensitive === true) return true;
  return process.env.MCP_PII_MASK_DEFAULT === "true";
}

function applyOutputMaskIfNeeded(
  state: LoopState,
  desc: PendingToolDescriptor | undefined,
  output: string,
): string {
  if (!piiMaskingEnabled(state, desc)) return output;
  // Sync path — regex baseline only. Used when caller can't await.
  const r = maskPii(output, state.piiTokenMap);
  state.piiTokenMap = r.tokenMap;
  if (r.applied.length > 0) {
    emitAuditEvent({
      trace_id: state.correlation.traceId,
      source_service: "mcp-server",
      kind: "pii.masked",
      capability_id: state.correlation.capabilityId,
      severity: "info",
      payload: {
        tool: desc?.name,
        kinds: r.applied.map((a) => ({ kind: a.kind, count: a.count })),
        ner_active: process.env.MCP_PII_NER_ENABLED === "true",
        // DO NOT include actual PII values in audit payload — just counts.
      },
    });
  }
  return r.masked;
}

/**
 * M39.B — async variant of applyOutputMaskIfNeeded that includes NER detections
 * when MCP_PII_NER_ENABLED=true. Use this from async splice points; falls
 * through to the regex-only sync path when NER is disabled.
 */
async function applyOutputMaskIfNeededAsync(
  state: LoopState,
  desc: PendingToolDescriptor | undefined,
  output: string,
): Promise<string> {
  if (!piiMaskingEnabled(state, desc)) return output;
  if (process.env.MCP_PII_NER_ENABLED !== "true") {
    return applyOutputMaskIfNeeded(state, desc, output);
  }
  const r = await maskPiiAsync(output, state.piiTokenMap);
  state.piiTokenMap = r.tokenMap;
  if (r.applied.length > 0) {
    emitAuditEvent({
      trace_id: state.correlation.traceId,
      source_service: "mcp-server",
      kind: "pii.masked",
      capability_id: state.correlation.capabilityId,
      severity: "info",
      payload: {
        tool: desc?.name,
        kinds: r.applied.map((a) => ({ kind: a.kind, count: a.count })),
        ner_active: true,
      },
    });
  }
  return r.masked;
}

function applyArgsUnmaskIfNeeded<T>(state: LoopState, args: T): T {
  if (process.env.MCP_PII_MASK_ENABLED === "false") return args;
  if (Object.keys(state.piiTokenMap).length === 0) return args;
  const out = unmaskPiiInArgs(args, state.piiTokenMap);
  // Audit emit happens via the tool invocation itself; we just emit a marker.
  emitAuditEvent({
    trace_id: state.correlation.traceId,
    source_service: "mcp-server",
    kind: "pii.unmasked",
    capability_id: state.correlation.capabilityId,
    severity: "info",
    payload: { token_count: Object.keys(state.piiTokenMap).length },
  });
  return out;
}

// ── GET /mcp/pending — operator visibility ───────────────────────────────

invokeRouter.get("/pending", (_req, res) => {
  res.json({
    success: true,
    data: {
      pending: peekPending,  // only used by tests; keep the array endpoint below
    },
    requestId: res.locals.requestId,
  });
});

invokeRouter.get("/pending/:token", (req, res) => {
  const env = peekPending(req.params.token);
  if (!env) throw new NotFoundError("continuation_token not found");
  // Don't echo full message history to operator UIs — too verbose.
  res.json({
    success: true,
    data: {
      continuation_token: env.continuation_token,
      created_at: env.created_at,
      expires_at: env.expires_at,
      trace_id: env.trace_id,
      mcp_invocation_id: env.mcp_invocation_id,
      pending_tool_call: env.pending_tool_call,
      pending_tool_descriptor: env.pending_tool_descriptor,
      step_index: env.step_index,
    },
    requestId: res.locals.requestId,
  });
});

// ── shared dispatch helper ───────────────────────────────────────────────

async function dispatchToolCall(
  tc: ToolCall,
  available: PendingToolDescriptor[],
  correlation: CorrelationIds,
  approvedContinuationToken?: string,
  workspaceRoot?: string,
): Promise<DispatchToolResult> {
  const start = Date.now();
  events.publish({
    kind: "tool.invocation.created",
    correlation: { ...correlation },
    payload: { tool_name: tc.name, args: tc.args },
  });

  const finishWith = (rec: ToolInvocationRecord, severity: "info" | "error" = "info") => {
    const executionMetadata = verificationExecutionMetadata(rec.output);
    events.publish({
      kind: "tool.invocation.updated",
      correlation: { ...correlation, toolInvocationId: rec.id },
      severity,
      payload: {
        tool_name: rec.tool_name, success: rec.success, error: rec.error,
        error_code: rec.error_code,
        latency_ms: rec.latency_ms,
        ...executionMetadata,
      },
    });
    // M21 — fire-and-forget to audit-governance
    emitAuditEvent({
      trace_id:      correlation.traceId,
      source_service: "mcp-service",
      kind:          "tool.invocation.completed",
      subject_type:  "ToolInvocation",
      subject_id:    rec.id,
      capability_id: correlation.capabilityId,
      severity:      rec.success ? "info" : "warn",
      payload: {
        tool_name:  rec.tool_name,
        success:    rec.success,
        error:      rec.error,
        error_code: rec.error_code,
        latency_ms: rec.latency_ms,
        ...executionMetadata,
      },
    });
    return { record: rec };
  };

  const desc = available.find((d) => d.name === tc.name);
  if (!desc) {
    return finishWith(
      recordToolInvocation({
        correlation, tool_name: tc.name, args: tc.args, output: null,
        success: false, error: `tool '${tc.name}' not registered for this run`,
        latency_ms: Date.now() - start,
      }),
      "error",
    );
  }

  if (desc.execution_target === "SERVER") {
    try {
      const token = config.CONTEXT_FABRIC_SERVICE_TOKEN ?? config.MCP_BEARER_TOKEN;
      const url = `${config.CONTEXT_FABRIC_URL.replace(/\/$/, "")}/internal/mcp/tools/${encodeURIComponent(tc.name)}/call`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Token": token,
        },
        body: JSON.stringify({
          traceId: correlation.traceId,
          capabilityId: correlation.capabilityId,
          agentId: correlation.agentId,
          agentUid: correlation.agentId ?? correlation.capabilityId ?? "mcp-agent",
          sessionId: correlation.sessionId,
          workflowInstanceId: correlation.workflowInstanceId ?? correlation.runId,
          nodeId: correlation.nodeId ?? correlation.runStepId,
          workItemId: correlation.workItemId,
          toolName: tc.name,
          toolVersion: desc.version,
          approvalId: approvedContinuationToken,
          args: tc.args ?? {},
        }),
        signal: AbortSignal.timeout((config.TIMEOUT_SEC ?? 240) * 1000),
      });
      // M35.4 — capture raw response body even when JSON parse fails so we
      // can debug 5xx errors from context-fabric. Previously the silent
      // .catch(() => ({})) made every parse failure look like an empty 200.
      let body: { status?: string; error?: unknown; reason?: unknown; tool_execution_id?: unknown; receipt?: unknown } = {};
      let rawBody = "";
      try {
        rawBody = await response.text();
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch (parseErr) {
        log.warn({ url, status: response.status, parseErr: (parseErr as Error).message, rawBody: rawBody.slice(0, 200) },
          "context-fabric SERVER tool adapter returned non-JSON body");
      }
      if (!response.ok) {
        throw new Error(`context-fabric SERVER tool adapter returned ${response.status}: ${rawBody.slice(0, 400) || JSON.stringify(body).slice(0, 400)}`);
      }
      if (body.status === "waiting_approval") {
        const rec = recordToolInvocation({
          correlation,
          tool_name: tc.name,
          args: tc.args,
          output: body,
          success: false,
          error: String(body.reason ?? "SERVER tool requires approval"),
          latency_ms: Date.now() - start,
        });
        const out = finishWith(rec, "info");
        return {
          ...out,
          approvalRequired: {
            reason: String(body.reason ?? "SERVER tool requires approval"),
            riskLevel: desc.risk_level,
          },
        };
      }
      const success = body.status === "success";
      const delegationReceipt = {
        kind: "delegation_receipt",
        execution_target: "SERVER",
        tool_name: tc.name,
        tool_version: desc.version,
        status: body.status ?? "unknown",
        context_fabric_url: config.CONTEXT_FABRIC_URL,
        tool_execution_id: typeof body.tool_execution_id === "string" ? body.tool_execution_id : undefined,
        downstream_receipt: body.receipt,
        capturedAt: new Date().toISOString(),
      };
      return finishWith(
        recordToolInvocation({
          correlation,
          tool_name: tc.name,
          args: tc.args,
          output: { ...body, delegation_receipt: delegationReceipt },
          success,
          error: success ? undefined : String(body.error ?? body.reason ?? `SERVER tool returned ${body.status ?? "unknown"}`),
          latency_ms: Date.now() - start,
        }),
        success ? "info" : "error",
      );
    } catch (err) {
      return finishWith(
        recordToolInvocation({
          correlation, tool_name: tc.name, args: tc.args, output: null,
          success: false, error: (err as Error).message,
          latency_ms: Date.now() - start,
        }),
        "error",
      );
    }
  }

  const handler = getLocalTool(tc.name);
  if (!handler) {
    return finishWith(
      recordToolInvocation({
        correlation, tool_name: tc.name, args: tc.args, output: null,
        success: false, error: `tool '${tc.name}' is LOCAL but no handler is registered`,
        latency_ms: Date.now() - start,
      }),
      "error",
    );
  }

  try {
    const r = workspaceRoot
      ? await withSandboxRoot(workspaceRoot, () => handler.execute(tc.args))
      : await handler.execute(tc.args);
    const rec = recordToolInvocation({
      correlation, tool_name: tc.name, args: tc.args,
      output: r.output, success: r.success, error: r.error,
      error_code: r.error_code,
      latency_ms: Date.now() - start,
    });
    // M13 — provenance extraction. Only on success; failures don't have
    // meaningful output. The extractor returns null for non-code-change
    // tools so this is cheap.
    let codeChange: CodeChangeRecord | undefined;
    if (r.success) {
      const partial = extractCodeChange({
        tool_name: tc.name, args: tc.args, output: r.output,
        correlation: { ...correlation, toolInvocationId: rec.id },
      });
      if (partial) {
        codeChange = recordCodeChange(partial);
        events.publish({
          kind: "code_change.detected",
          correlation: { ...correlation, toolInvocationId: rec.id, artifactId: codeChange.id },
          payload: {
            code_change_id: codeChange.id,
            tool_name: codeChange.tool_name,
            paths_touched: codeChange.paths_touched,
            has_diff: Boolean(codeChange.diff),
            has_patch: Boolean(codeChange.patch),
            has_commit: Boolean(codeChange.commit_sha),
            source: codeChange.source,
          },
        });
        if (codeChange.commit_sha) {
          events.publish({
            kind: "git.commit.created",
            correlation: { ...correlation, toolInvocationId: rec.id, artifactId: codeChange.id },
            payload: {
              code_change_id: codeChange.id,
              commit_sha: codeChange.commit_sha,
              paths_touched: codeChange.paths_touched,
            },
          });
        }
      }
    }
    const out = finishWith(rec, r.success ? "info" : "error");
    return { ...out, codeChange };
  } catch (err) {
    return finishWith(
      recordToolInvocation({
        correlation, tool_name: tc.name, args: tc.args, output: null,
        success: false, error: (err as Error).message,
        latency_ms: Date.now() - start,
      }),
      "error",
    );
  }
}
