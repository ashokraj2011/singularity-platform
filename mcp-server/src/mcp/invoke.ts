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
import { runVerificationCommand, parseTestRunnerOutput, diffTestResults } from "../tools/command";
import { detectVerifiers } from "../workspace/verifier-registry";
import {
  CorrelationIds, recordLlmCall, recordToolInvocation, recordArtifact,
  recordCodeChange, ToolInvocationRecord, CodeChangeRecord,
  LlmCallRecord,
} from "../audit/store";
import { emitRePlan } from "../audit/replan-telemetry";
import { extractCodeChange } from "../audit/provenanceExtractor";
import { events } from "../events/bus";
import { emitAuditEvent } from "../lib/audit-gov-emit";
import { checkBudget, checkRateLimit, GovernanceMode } from "../lib/audit-gov-check";
import { isDegradedToolAllowedByPolicy, isRiskyToolByPolicy } from "../lib/governance-policy";
import { persistApproval, consumeApproval } from "../lib/audit-gov-approvals";
import {
  savePending, takePending, peekPending, clearPending, PendingToolDescriptor,
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
// Phased Agent Reasoning Model (v4) — types only; the state machine is
// driven from runLoop via the helpers in phases.ts and plan.ts.
// PhaseLoopStateView will be imported when runLoop integration lands.
import type { Phase, PhaseBudgets } from "./phases";
import type { Plan, PlanProgress } from "./plan";

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
    // ── Phased Agent Reasoning Model (v4) ───────────────────────────────
    // agentReasoningMode lets the caller (workgraph-api / context-fabric)
    // explicitly opt the run into the phase machine. `"phased"` activates
    // when MCP_AGENT_PHASES_ENABLED is also true at the server. `"flat"`
    // forces the legacy single-loop behavior regardless of the env flag.
    // Missing field is treated as "flat" for backward compatibility.
    agentReasoningMode: z.enum(["phased", "flat"]).optional(),
    // Per-phase step budgets. Without these in the Zod schema, the field
    // would be stripped silently and the per-phase budgets would not reach
    // the server. Missing keys fall back to DEFAULT_PHASE_BUDGETS.
    phaseBudgets: z.object({
      PLAN_DRAFT: z.number().int().positive().optional(),
      EXPLORE: z.number().int().positive().optional(),
      PLAN_CONFIRM: z.number().int().positive().optional(),
      ACT: z.number().int().positive().optional(),
      VERIFY: z.number().int().positive().optional(),
      FINALIZE: z.number().int().positive().optional(),
    }).optional(),
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

  // ── Phased Agent Reasoning Model (v4) ─────────────────────────────────
  // Populated only when agentReasoningMode === "phased" AND the server has
  // MCP_AGENT_PHASES_ENABLED. Null/undefined means the legacy flat loop is
  // active and the phase machine should not gate tool calls.
  phaseMachine?: {
    phase: Phase;
    plan: Plan | null;
    planProgress: PlanProgress;
    /** Per-phase budgets (defaults filled in from DEFAULT_PHASE_BUDGETS). */
    phaseBudgets: PhaseBudgets;
    /** Steps consumed per phase so far. */
    phaseStepUsage: Record<Phase, number>;
    /** Per-phase repetition counters (count + last tool key) for the
     *  phase-aware detector. Key includes args+output hash so a CONFLICT
     *  retry that yields a different output does not increment. */
    phaseRepetitionCounters: Record<Phase, { lastKey?: string; count: number }>;
    /** Count of tool-call attempts the model made for tools NOT in the
     *  current phase's allowlist. Bumped each time a gated rejection is
     *  emitted; surfaces to audit so trace.sh can show the agent's hit-rate. */
    phaseViolationCount: number;
    /** True when PLAN_DRAFT exhausted its budget and we substituted a
     *  fallback plan. Causes the path-coverage check to be vacuous. */
    planFromFallback: boolean;
  };
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
const MUTATION_TOOL_NAMES = new Set(["apply_patch", "replace_text", "replace_range", "write_file"]);

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

/**
 * M43 Slice 3 — pure helper, exported for testability. Computes the
 * verification-coverage signal that the workgraph-side gate reads from
 * `correlation.verificationCoverage`.
 *
 * `gap = codeChanged && !receiptsPresent` — verification_unavailable still
 * counts as a receipt (the agent explicitly acknowledged no verifier), so a
 * gap means the agent skipped VERIFY entirely after making code changes.
 */
export function computeVerificationCoverage(
  codeChangeIdCount: number,
  receipts: ReadonlyArray<Record<string, unknown>>,
): {
  codeChanged: boolean;
  receiptsPresent: boolean;
  hasPassingReceipt: boolean;
  hasUnavailableReceipt: boolean;
  gap: boolean;
} {
  const codeChanged = codeChangeIdCount > 0;
  const receiptsPresent = receipts.length > 0;
  const hasPassingReceipt = receipts.some((r) =>
    r.passed === true ||
    r.exit_code === 0 ||
    (r as { exitCode?: unknown }).exitCode === 0,
  );
  const hasUnavailableReceipt = receipts.some((r) =>
    String(r.command ?? "") === "verification_unavailable" ||
    r.unavailable === true ||
    r.verification_kind === "unavailable",
  );
  return {
    codeChanged,
    receiptsPresent,
    hasPassingReceipt,
    hasUnavailableReceipt,
    gap: codeChanged && !receiptsPresent,
  };
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

/**
 * M48 — Bridge helper: extract receipts from a tool output, enrich each
 * with a per-test diff against any previously-captured baseline already
 * in state, and return the enriched receipts ready to push.
 */
function enrichedReceiptsFromOutput(
  state: LoopState,
  output: unknown,
  toolInvocationId: string,
  toolName: string,
): Array<Record<string, unknown>> {
  const raw = verificationReceiptsFromOutput(output, toolInvocationId, toolName);
  return raw.map((r) => enrichWithBaselineDiff(r, state.verificationReceipts));
}

/**
 * M48 — Enrich a fresh verification receipt with a per-test diff against a
 * previously-captured baseline. Returns the receipt unchanged when no
 * baseline exists, when the runner output isn't parseable, or when this
 * IS the baseline receipt itself. Called by the loop after collecting
 * receipts from a tool invocation but before pushing them to state.
 */
function enrichWithBaselineDiff(
  fresh: Record<string, unknown>,
  existingReceipts: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  // The baseline receipt itself shouldn't be diffed.
  if (fresh.verification_kind === "baseline") return fresh;
  // Find the most recent baseline receipt in state.
  const baseline = [...existingReceipts].reverse().find(r => r.verification_kind === "baseline");
  if (!baseline) return fresh;
  // Need stdout from both. Receipts truncate stdout to `stdout_excerpt`
  // which may be a string OR { kind: "compressed_text", excerpt }. Unwrap.
  const unwrapStdout = (r: Record<string, unknown>): string => {
    const raw = r.stdout_excerpt ?? r.stdout ?? "";
    if (typeof raw === "string") return raw;
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.excerpt === "string") return obj.excerpt;
    }
    return "";
  };
  const baselineCmd = String(baseline.command ?? "");
  const freshCmd = String(fresh.command ?? "");
  const baselineParsed = parseTestRunnerOutput(unwrapStdout(baseline), baselineCmd);
  const freshParsed = parseTestRunnerOutput(unwrapStdout(fresh), freshCmd);
  if (baselineParsed.format === "unparseable" || freshParsed.format === "unparseable") {
    return { ...fresh, baseline_diff_unavailable: "test runner output not parseable; gate falls back to raw exit_code" };
  }
  const diff = diffTestResults(baselineParsed, freshParsed);
  return {
    ...fresh,
    baseline_diff: {
      pre_existing_failures: diff.pre_existing_failures,
      regressions: diff.regressions,
      fixed: diff.fixed,
      hasRegressions: diff.hasRegressions,
      baseline_total: baselineParsed.totalTests,
      post_total: freshParsed.totalTests,
    },
    // When there are no regressions but raw passed=false (because of
    // pre-existing failures), surface an effective_passed=true so the
    // workgraph gate has a clear gradient between "really failed" and
    // "still has only the upstream-broken tests."
    effective_passed: !diff.hasRegressions,
  };
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
  const hasMutationTools = hasTool(state, Array.from(MUTATION_TOOL_NAMES));
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

// ─── Phased Agent Reasoning Model (v4) — runtime helpers ────────────────
//
// These functions bridge the pure logic in phases.ts / plan.ts with the
// mutable LoopState the existing runLoop already manages. Each is small,
// safe-when-phaseMachine-is-absent, and well-named so the runLoop
// integration reads top-to-bottom.
//
// When state.phaseMachine is undefined (the default), every helper is a
// no-op, so the flat-loop path is completely unaffected.

import {
  PHASE_REPETITION_RULES,
  TOOL_ALLOWLISTS,
  computeCodeChangeCoverage,
  formatGatedToolError,
  isToolAllowed as isPhaseToolAllowed,
  nextPhase,
  synthesizeFallbackPlan,
  synthesizePhaseFrame,
  DEFAULT_PHASE_BUDGETS,
} from "./phases";
import {
  initialPlanProgress,
  markEdited,
  markRead,
  parsePlanResponse,
  diffPlans,
} from "./plan";

/** Initialise the phase-machine slot on a fresh LoopState. Returns the
 *  populated machine, or undefined if phased mode isn't active. Called
 *  exactly once per run at the bottom of executeInvokePayload, BEFORE the
 *  first call to runLoop. Safe to no-op for resume — the resume path
 *  rehydrates phaseMachine directly from the persisted envelope. */
function initPhaseMachine(
  agentReasoningMode: "phased" | "flat" | undefined,
  phaseBudgets: PhaseBudgets | undefined,
): LoopState["phaseMachine"] | undefined {
  const phasedRequested = agentReasoningMode === "phased";
  const phasedEnabled = config.MCP_AGENT_PHASES_ENABLED === true;
  if (!phasedRequested || !phasedEnabled) return undefined;
  const resolvedBudgets: PhaseBudgets = { ...DEFAULT_PHASE_BUDGETS, ...(phaseBudgets ?? {}) };
  return {
    phase: "PLAN_DRAFT",
    plan: null,
    planProgress: {},
    phaseBudgets: resolvedBudgets,
    phaseStepUsage: { PLAN_DRAFT: 0, EXPLORE: 0, PLAN_CONFIRM: 0, ACT: 0, VERIFY: 0, FINALIZE: 0 },
    phaseRepetitionCounters: {
      PLAN_DRAFT: { count: 0 }, EXPLORE: { count: 0 }, PLAN_CONFIRM: { count: 0 },
      ACT: { count: 0 }, VERIFY: { count: 0 }, FINALIZE: { count: 0 },
    },
    phaseViolationCount: 0,
    planFromFallback: false,
  };
}

/** Build the augmented messages + filtered tool lists used for ONE LLM call.
 *  Does not mutate state. When phaseMachine is absent, returns the original
 *  state arrays unchanged (zero overhead). */
function applyPhaseFilteringForLlmCall(state: LoopState): {
  messages: ChatMessage[];
  availableTools: ToolDescriptorForLlm[];
  fullToolDescriptors: PendingToolDescriptor[];
} {
  if (!state.phaseMachine) {
    return {
      messages: state.messages,
      availableTools: state.availableTools,
      fullToolDescriptors: state.fullToolDescriptors,
    };
  }
  const phase = state.phaseMachine.phase;
  const allow = TOOL_ALLOWLISTS[phase];
  const filteredAvail = state.availableTools.filter((t) => allow.has(t.name));
  const filteredFull = state.fullToolDescriptors.filter((t) => allow.has(t.name));
  const frame = synthesizePhaseFrame({
    phase: state.phaseMachine.phase,
    plan: state.phaseMachine.plan,
    planProgress: state.phaseMachine.planProgress,
    phaseStepUsage: state.phaseMachine.phaseStepUsage,
    phaseBudgets: state.phaseMachine.phaseBudgets,
    planFromFallback: state.phaseMachine.planFromFallback,
  });
  // Inject the frame as the LAST system message so the model reads it most
  // recently. We append rather than mutate state.messages so the sliding
  // window never sees an accumulating stack of phase frames.
  const messages: ChatMessage[] = [...state.messages, { role: "system", content: frame }];
  return { messages, availableTools: filteredAvail, fullToolDescriptors: filteredFull };
}

/** Attempt to parse a Plan from the assistant text response. Called after
 *  every LLM call in PLAN_DRAFT and PLAN_CONFIRM phases. On success, mutates
 *  state.phaseMachine to record the new plan (and emits audit events for
 *  revisions). On failure, leaves state untouched — the run continues. */
function tryParsePlanFromAssistant(state: LoopState, llmResp: LlmResponse): "parsed" | "no-json" | "invalid" {
  if (!state.phaseMachine) return "no-json";
  if (!llmResp.content) return "no-json";
  const phase = state.phaseMachine.phase;
  if (phase !== "PLAN_DRAFT" && phase !== "PLAN_CONFIRM") return "no-json";
  const result = parsePlanResponse(llmResp.content);
  if (!result.ok) return result.error.startsWith("No parseable JSON") ? "no-json" : "invalid";
  const newPlan = result.plan;
  if (phase === "PLAN_DRAFT") {
    state.phaseMachine.plan = newPlan;
    state.phaseMachine.planProgress = initialPlanProgress(newPlan);
    state.phaseMachine.planFromFallback = false;
    emitAuditEvent({
      trace_id: state.correlation.traceId,
      source_service: "mcp-server",
      kind: "agent.plan.drafted",
      capability_id: state.correlation.capabilityId,
      severity: "info",
      payload: {
        targetCount: newPlan.targets.length,
        requiredCount: newPlan.targets.filter((t) => t.required).length,
      },
    });
  } else {
    // PLAN_CONFIRM — diff against existing plan
    const previous = state.phaseMachine.plan;
    if (previous) {
      const diff = diffPlans(previous, newPlan, state.phaseMachine.planProgress);
      if (diff.dropped.length > 0 || diff.added.length > 0 || diff.intentChanged.length > 0 || diff.requiredFlipped.length > 0) {
        emitAuditEvent({
          trace_id: state.correlation.traceId,
          source_service: "mcp-server",
          kind: "agent.plan.revised",
          capability_id: state.correlation.capabilityId,
          severity: diff.hasUnjustifiedDrops ? "warn" : "info",
          payload: {
            droppedFiles: diff.dropped.map((t) => t.file),
            addedFiles: diff.added.map((t) => t.file),
            intentChangedFiles: diff.intentChanged.map((c) => c.file),
            requiredFlipped: diff.requiredFlipped,
            hasUnjustifiedDrops: diff.hasUnjustifiedDrops,
          },
        });
      }
    }
    state.phaseMachine.plan = newPlan;
    // Merge progress: keep edited/skipped statuses from previous; add new pending entries.
    const merged: PlanProgress = { ...state.phaseMachine.planProgress };
    for (const t of newPlan.targets) {
      if (!merged[t.file]) merged[t.file] = { status: t.status };
    }
    state.phaseMachine.planProgress = merged;

    // M48 — Baseline coherence: if the agent captured a test baseline with
    // failures but the confirmed plan doesn't address any of them, surface
    // a warning so operators can decide whether to send back. We don't
    // block — the agent might legitimately have decided the failures are
    // out of scope and used skipReason elsewhere.
    checkBaselineAddressed(state, newPlan);
  }
  return "parsed";
}

/**
 * M48 — Warn (via audit) when a baseline-of-failing-tests exists but the
 * confirmed plan has no targets that touch any of them. The check uses a
 * loose name-match (failing test method or class name appears in any
 * target's file path or intent text) so it works without exact path
 * resolution. False negatives are fine — the goal is to flag obvious
 * "ignored baseline" cases, not to enumerate every legitimate scope call.
 */
function checkBaselineAddressed(state: LoopState, plan: Plan): void {
  const baseline = [...state.verificationReceipts].reverse().find(r => r.verification_kind === "baseline");
  if (!baseline) return;
  const baselineFailing = (baseline.baseline_diff as { pre_existing_failures?: string[] } | undefined)?.pre_existing_failures
    ?? (() => {
      // Baseline receipts don't have a baseline_diff on themselves; parse stdout directly
      const stdoutRaw = baseline.stdout_excerpt ?? baseline.stdout ?? "";
      const stdout = typeof stdoutRaw === "string" ? stdoutRaw : (stdoutRaw && typeof stdoutRaw === "object" && typeof (stdoutRaw as { excerpt?: unknown }).excerpt === "string" ? (stdoutRaw as { excerpt: string }).excerpt : "");
      const parsed = parseTestRunnerOutput(stdout, String(baseline.command ?? ""));
      return parsed.failingTests;
    })();
  if (!baselineFailing || baselineFailing.length === 0) return;

  // Match: a failing test like "org.example.Foo.testBar" should be considered
  // addressed if any required target's file path contains "Foo" OR its
  // intent text mentions the test name's last segment.
  const tail = (s: string): string => s.split(".").slice(-2).join(".");
  const classOnly = (s: string): string => s.split(".").slice(-2, -1).join("");
  const unaddressed = baselineFailing.filter(t => {
    const cls = classOnly(t);
    const fullTail = tail(t);
    return !plan.targets.some(target =>
      target.required && target.status !== "skipped" && (
        target.file.includes(cls) || target.intent.toLowerCase().includes(fullTail.toLowerCase()) || target.intent.toLowerCase().includes(t.toLowerCase())
      ),
    );
  });
  if (unaddressed.length === 0) return;
  emitAuditEvent({
    trace_id: state.correlation.traceId,
    source_service: "mcp-server",
    kind: "agent.plan.baseline_unaddressed",
    capability_id: state.correlation.capabilityId,
    severity: "warn",
    payload: {
      message:
        "Baseline captured failing tests that the confirmed plan does not appear to address. " +
        "The agent should add a kind:'test' or kind:'code' target for each, OR mark them skipped with skipReason. " +
        "Skipping silently means the verification gate accepts the run as-is via baseline_diff (effective_passed=true).",
      unaddressed,
      planTargetFiles: plan.targets.map(t => t.file),
    },
  });
}

/** Decide whether a tool call is allowed in the current phase. Returns the
 *  friendly error string if blocked, otherwise null. When phaseMachine is
 *  absent, always returns null (no gating). */
function phaseGateForToolCall(state: LoopState, toolName: string): string | null {
  if (!state.phaseMachine) return null;
  if (isPhaseToolAllowed(state.phaseMachine.phase, toolName)) return null;
  state.phaseMachine.phaseViolationCount += 1;
  const hint =
    state.phaseMachine.phase === "PLAN_DRAFT"
      ? "Emit a plan JSON object to advance to EXPLORE."
      : state.phaseMachine.phase === "EXPLORE"
        ? "Read each required plan target file to advance to PLAN_CONFIRM."
        : state.phaseMachine.phase === "PLAN_CONFIRM"
          ? "Emit a confirmed plan JSON to advance to ACT."
          : state.phaseMachine.phase === "ACT"
            ? "Apply each required target's edit (or mark skipped with reason) to advance to VERIFY."
            : state.phaseMachine.phase === "VERIFY"
              ? "Call run_test, run_command, or verification_unavailable to advance to FINALIZE."
              : "Phase auto-finishes — emit a final summary text response.";
  return formatGatedToolError(state.phaseMachine.phase, toolName, hint);
}

/** After a successful tool dispatch, update planProgress based on what the
 *  tool touched. Tracks `read` (when a read-only tool inspects a target
 *  file), `edited` (when a mutation tool touches one), and `skipped` (when
 *  the agent emits a special `plan_skip` pseudo-tool — Phase-V5 placeholder,
 *  not yet exposed). */
function recordPhaseToolEffect(
  state: LoopState,
  toolName: string,
  toolArgs: Record<string, unknown>,
  codeChangePaths: string[],
): void {
  if (!state.phaseMachine || !state.phaseMachine.plan) return;
  const READ_TOOLS = new Set(["read_file", "get_ast_slice", "get_symbol", "search_code", "list_directory"]);
  if (READ_TOOLS.has(toolName) && typeof toolArgs.path === "string") {
    state.phaseMachine.planProgress = markRead(state.phaseMachine.planProgress, toolArgs.path, state.stepIndex);
  } else if (toolName === "get_ast_slice" && typeof toolArgs.filePath === "string") {
    state.phaseMachine.planProgress = markRead(state.phaseMachine.planProgress, toolArgs.filePath, state.stepIndex);
  }
  for (const p of codeChangePaths) {
    state.phaseMachine.planProgress = markEdited(state.phaseMachine.planProgress, p, state.stepIndex);
  }
}

/** Phase-aware repetition detector. Returns the offending count when the
 *  detector should fire, null otherwise. Uses PHASE_REPETITION_RULES.
 *  Compares argsHash AND (optionally) outputHash so that a CONFLICT-then-
 *  retry-with-new-hash does NOT trip in ACT. */
function detectPhaseRepetition(
  state: LoopState,
  toolName: string,
  argsHash: string,
  outputDigest: string,
): { count: number; threshold: number } | null {
  if (!state.phaseMachine) return null;
  const phase = state.phaseMachine.phase;
  const rule = PHASE_REPETITION_RULES[phase];
  const counter = state.phaseMachine.phaseRepetitionCounters[phase];
  const key = rule.compareOutput ? `${toolName}|${argsHash}|${outputDigest}` : `${toolName}|${argsHash}`;
  if (counter.lastKey === key) {
    counter.count += 1;
  } else {
    counter.lastKey = key;
    counter.count = 1;
  }
  if (counter.count >= rule.threshold) {
    return { count: counter.count, threshold: rule.threshold };
  }
  return null;
}

/** Reset the current phase's repetition counter — called when the tool call
 *  succeeded with a meaningful state change (mutation success, CONFLICT
 *  error_code triggering a re-read, or any phase transition). */
function resetPhaseRepetition(state: LoopState): void {
  if (!state.phaseMachine) return;
  state.phaseMachine.phaseRepetitionCounters[state.phaseMachine.phase] = { count: 0 };
}

/** Aggregate every code-change path touched so far in this run, derived from
 *  state.planProgress's "edited" entries. Used by the ACT transition gate
 *  and by computeCodeChangeCoverage at run completion. */
function accumulatedCodeChangePaths(state: LoopState): ReadonlySet<string> {
  if (!state.phaseMachine) return new Set();
  const out = new Set<string>();
  for (const [file, entry] of Object.entries(state.phaseMachine.planProgress)) {
    if (entry.status === "edited") out.add(file);
  }
  return out;
}

/** Wrapper that pulls the phaseMachine state and delegates to phases.ts's
 *  computeCodeChangeCoverage. Returns null if phaseMachine is absent. */
function computeCodeChangeCoverageHelper(state: LoopState) {
  if (!state.phaseMachine) {
    return { required: [], covered: [], skipped: [], missing: [], hasRequiredCodeGap: false };
  }
  return computeCodeChangeCoverage(
    state.phaseMachine.plan,
    state.phaseMachine.planProgress,
    accumulatedCodeChangePaths(state),
  );
}

/** Increment the current phase's step counter and check for transition.
 *  Called at the end of each loop iteration. Returns the new phase if a
 *  transition happened, otherwise null. */
function advancePhaseStepAndMaybeTransition(
  state: LoopState,
  accumulatedCodeChangePaths: ReadonlySet<string>,
): Phase | null {
  if (!state.phaseMachine) return null;
  const cur = state.phaseMachine.phase;
  state.phaseMachine.phaseStepUsage[cur] += 1;
  const view = {
    phase: state.phaseMachine.phase,
    plan: state.phaseMachine.plan,
    planProgress: state.phaseMachine.planProgress,
    phaseStepUsage: state.phaseMachine.phaseStepUsage,
    phaseBudgets: state.phaseMachine.phaseBudgets,
    planFromFallback: state.phaseMachine.planFromFallback,
  };
  const target = nextPhase(view, accumulatedCodeChangePaths);
  if (!target || target === cur) return null;
  // Transitioning. If we were leaving PLAN_DRAFT without a plan, synthesize
  // a fallback so downstream phases have something to anchor on.
  if (cur === "PLAN_DRAFT" && !state.phaseMachine.plan) {
    const languages = state.workspace?.changedPaths ?? [];  // rough heuristic; better signal lives in source-materializer
    const fallback = synthesizeFallbackPlan(languages, /* goal */ state.messages.find((m) => m.role === "user")?.content ?? "");
    state.phaseMachine.plan = fallback;
    state.phaseMachine.planProgress = initialPlanProgress(fallback);
    state.phaseMachine.planFromFallback = true;
    emitAuditEvent({
      trace_id: state.correlation.traceId,
      source_service: "mcp-server",
      kind: "agent.plan.fallback_synthesized",
      capability_id: state.correlation.capabilityId,
      severity: "warn",
      payload: { reason: "PLAN_DRAFT budget exhausted without valid JSON" },
    });
  }
  state.phaseMachine.phase = target;
  resetPhaseRepetition(state);
  // M44 Slice F — cache-stability telemetry. Anthropic's prompt cache hashes
  // the `tools` block as part of the cacheable prefix; when the tool list
  // changes between phases, downstream cache hits are lost from that point.
  // The diff payload makes the cost of phase filtering visible to operators
  // without changing provider behaviour. Pair with a future cache_control
  // breakpoint placement to actually cap the invalidation surface.
  const prevTools = TOOL_ALLOWLISTS[cur];
  const nextTools = TOOL_ALLOWLISTS[target];
  const toolsRemoved = [...prevTools].filter((t) => !nextTools.has(t)).sort();
  const toolsAdded = [...nextTools].filter((t) => !prevTools.has(t)).sort();
  emitAuditEvent({
    trace_id: state.correlation.traceId,
    source_service: "mcp-server",
    kind: "agent.phase.transitioned",
    capability_id: state.correlation.capabilityId,
    severity: "info",
    payload: {
      from: cur,
      to: target,
      stepIndex: state.stepIndex,
      // M44 Slice F — surface cache-prefix-invalidating churn for observability.
      toolsRemoved,
      toolsAdded,
      cachePrefixInvalidated: toolsRemoved.length > 0 || toolsAdded.length > 0,
    },
  });
  return target;
}

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
        phase: state.phaseMachine?.phase,
      },
    });

    // ── Phased Agent Reasoning Model (v4) ─────────────────────────────
    // When phaseMachine is set, filter the LLM-visible tools to the current
    // phase's allowlist AND inject a phase frame as a trailing system
    // message. When phaseMachine is undefined, returns state.* unchanged so
    // the flat-loop path is bit-identical to its previous behavior.
    const phasedView = applyPhaseFilteringForLlmCall(state);

    const llmResp = await llmRespond({
      model_alias: state.modelConfig.modelAlias,
      provider: state.modelConfig.provider,
      model: state.modelConfig.model,
      messages: phasedView.messages,
      tools: phasedView.availableTools,
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
      // [trace] full transcript-style capture so an operator can replay
      // exactly what the model saw and what it emitted — see the
      // `bin/trace.sh` viewer.
      step_index: state.stepIndex,
      phase: state.phaseMachine?.phase,
      prompt_messages_preview: buildPromptMessagesPreview(state.messages),
      response_text: captureResponseText(llmResp.content),
      response_tool_calls: buildResponseToolCallsPreview(llmResp.tool_calls),
    });
    state.llmCallIds.push(llmRec.id);

    // ── Phased Agent Reasoning Model (v4) ─────────────────────────────
    // After the LLM speaks, try to parse a plan from the assistant text if
    // we're in PLAN_DRAFT or PLAN_CONFIRM. No-op for other phases / when
    // phaseMachine is unset.
    tryParsePlanFromAssistant(state, llmResp);

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
          // [trace] applier path also captured. The applier sees a tightly
          // scoped pair (assistant tool_call → tool error / partial result),
          // so prompt_messages_preview will usually have 2 entries.
          step_index: state.stepIndex,
          response_text: captureResponseText(applierResp.content),
          response_tool_calls: buildResponseToolCallsPreview(applierResp.tool_calls),
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
              ...enrichedReceiptsFromOutput(state, result.record.output, result.record.id, tc.name)
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

            const rawOutput = toolMessageContentForRecord(state, result.record, tc.name);
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

        // ── Phased Agent Reasoning Model (v4) ───────────────────────────
        // Block tool calls not in the current phase's allowlist BEFORE
        // governance / approval gates. Append a friendly tool_result so the
        // model can self-correct on the next turn, then SKIP dispatch.
        const phaseGateError = phaseGateForToolCall(state, tc.name);
        if (phaseGateError) {
          emitAuditEvent({
            trace_id: state.correlation.traceId,
            source_service: "mcp-server",
            kind: "agent.phase.tool_violation",
            capability_id: state.correlation.capabilityId,
            severity: "warn",
            payload: {
              phase: state.phaseMachine?.phase,
              tool_name: tc.name,
              violation_count: state.phaseMachine?.phaseViolationCount,
            },
          });
          state.messages.push({
            role: "tool",
            content: JSON.stringify({ success: false, error: phaseGateError, kind: "phase_gated" }),
            tool_call_id: tc.id,
            tool_name: tc.name,
          });
          continue;
        }

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
        // M43 — review_diff needs the same loop-state context so it can report
        // verification coverage AND reconcile tracked code-change paths
        // against the working-tree diff. mutatedPaths is the same source the
        // path-coverage gate uses (populated at line ~1380 below).
        if (tc.name === "review_diff") {
          toolArgs.verificationReceipts = state.verificationReceipts;
          toolArgs.codeChangePaths = [...mutatedPaths];
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
        state.verificationReceipts.push(...enrichedReceiptsFromOutput(state, result.record.output, result.record.id, tc.name));
        if (result.record.error_code === "CONFLICT") {
          state.rePlanDepth++;
          // Phase repetition counter must reset on CONFLICT — a CONFLICT is a
          // legitimate signal to re-read and retry; the next call won't be a
          // pathological repeat even if args match.
          resetPhaseRepetition(state);
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
        // toolMessageContentForRecord surfaces tool errors (success=false) so
        // the LLM can correct its strategy instead of seeing a silent "null".
        const rawOutput = toolMessageContentForRecord(state, result.record, tc.name);
        const maskedOutput = await applyOutputMaskIfNeededAsync(state, desc, rawOutput);
        state.messages.push({
          role: "tool",
          content: maskedOutput,
          tool_call_id: tc.id,
          tool_name: tc.name,
        });

        // ── Phased Agent Reasoning Model (v4) ──────────────────────────
        // Update planProgress so the phase machine knows which target files
        // have been read or edited. No-op when phaseMachine is absent.
        recordPhaseToolEffect(
          state,
          tc.name,
          tc.args ?? {},
          result.codeChange?.paths_touched ?? [],
        );
        // Reset the phase-aware repetition counter on a successful mutation;
        // legit progress should clear the streak even if the same tool gets
        // called again.
        if (result.codeChange && result.record.success !== false) {
          resetPhaseRepetition(state);
        }

        // M28 boot-1 — repetition detector. When phaseMachine is set, use the
        // phase-aware detector (args+output identity in ACT) instead of the
        // global threshold. Either route can produce a denied outcome.
        state.toolCallHistory.push({
          name: tc.name,
          argsHash: argsHash(tc.args),
          stepIndex: state.stepIndex,
        });
        if (state.toolCallHistory.length > LOOP_REPETITION_WINDOW * 2) {
          state.toolCallHistory.splice(0, state.toolCallHistory.length - LOOP_REPETITION_WINDOW * 2);
        }
        const phaseRep = detectPhaseRepetition(
          state,
          tc.name,
          argsHash(tc.args),
          createHash("sha256").update(maskedOutput ?? "").digest("hex").slice(0, 16),
        );
        if (phaseRep) {
          const reason = `LLM looped on ${tc.name} in phase ${state.phaseMachine?.phase} (${phaseRep.count} consecutive identical calls with identical outputs, threshold=${phaseRep.threshold}).`;
          emitAuditEvent({
            trace_id: state.correlation.traceId,
            source_service: "mcp-server",
            kind: "agent_loop.repetition_detected",
            capability_id: state.correlation.capabilityId,
            severity: "warn",
            payload: {
              tool_name: tc.name,
              repetition_count: phaseRep.count,
              threshold: phaseRep.threshold,
              stepIndex: state.stepIndex,
              phase: state.phaseMachine?.phase,
              detector: "phase_aware",
            },
          });
          return { kind: "denied", finishReason: "agent_loop_repetition", reason, check: "loop_repetition", details: { tool_name: tc.name, repetition_count: phaseRep.count, phase: state.phaseMachine?.phase } };
        }
        // Fall back to the legacy global detector when phaseMachine is absent.
        if (!state.phaseMachine) {
          const rep = detectRepetition(state.toolCallHistory);
          if (rep) {
            const reason = `LLM looped on ${rep.name} (${rep.count} consecutive identical calls, threshold=${LOOP_REPETITION_THRESHOLD}). Agent is not making progress.`;
            emitAuditEvent({
              trace_id:      state.correlation.traceId,
              source_service: "mcp-server",
              kind:          "agent_loop.repetition_detected",
              capability_id: state.correlation.capabilityId,
              severity:      "warn",
              payload: { tool_name: rep.name, repetition_count: rep.count, threshold: LOOP_REPETITION_THRESHOLD, stepIndex: state.stepIndex, detector: "legacy" },
            });
            return { kind: "denied", finishReason: "agent_loop_repetition", reason, check: "loop_repetition", details: { tool_name: rep.name, repetition_count: rep.count } };
          }
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

      // ── Phased Agent Reasoning Model (v4) — phase advancement ─────────
      advancePhaseStepAndMaybeTransition(state, accumulatedCodeChangePaths(state));
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
      // ── Phased Agent Reasoning Model (v4) — phase advancement ─────────
      advancePhaseStepAndMaybeTransition(state, accumulatedCodeChangePaths(state));
      continue;
    }

    // ── Phased Agent Reasoning Model (v4) — handle finish_reason="stop" ─
    // For phased runs, a "stop" in PLAN_DRAFT/PLAN_CONFIRM/EXPLORE/ACT/VERIFY
    // is NOT necessarily the end of the run — it might be the end of THIS
    // phase. Advance the phase machine; if we've moved past FINALIZE or are
    // now in FINALIZE with zero allowed tools, the run is genuinely done.
    if (state.phaseMachine) {
      const beforePhase = state.phaseMachine.phase;
      const newPhase = advancePhaseStepAndMaybeTransition(state, accumulatedCodeChangePaths(state));
      state.stepIndex += 1;
      // If we just entered FINALIZE OR were already there OR transitioned
      // multiple phases away, complete with the model's final text.
      if (state.phaseMachine.phase === "FINALIZE" && beforePhase === "FINALIZE") {
        return {
          kind: "complete",
          finalContent: llmResp.content,
          finishReason: llmResp.finish_reason as "stop" | "length" | "error",
        };
      }
      // If the phase advanced (or stayed but budget exhausted on a phase
      // that returned null from nextPhase like VERIFY/PLAN_CONFIRM waiting
      // on the loop body), keep looping so the next LLM call runs under the
      // new phase's allowlist.
      if (newPhase !== null || beforePhase !== "FINALIZE") {
        continue;
      }
    }

    return {
      kind: "complete",
      finalContent: llmResp.content,
      finishReason: llmResp.finish_reason as "stop" | "length" | "error",
    };
  }
  if (!state.allowAutonomousMutation) {
    const finalized = await finalizeReadOnlyAfterMaxSteps(state);
    if (finalized) return finalized;
  }
  const mutated = await forceMutationAfterMaxSteps(state);
  if (mutated) return mutated;
  return { kind: "complete", finalContent: "", finishReason: "max_steps" };
}

function mutationToolsForFinalization(state: LoopState): ToolDescriptorForLlm[] {
  return state.availableTools.filter((tool) => MUTATION_TOOL_NAMES.has(tool.name));
}

function mutationFinalizationMaxTokens(state: LoopState): number {
  return Math.max(state.modelConfig.maxTokens ?? 0, Number(process.env.MCP_MUTATION_FINALIZATION_MAX_TOKENS ?? 4096));
}

async function forceMutationAfterMaxSteps(state: LoopState): Promise<LoopOutcome | null> {
  if (!state.allowAutonomousMutation) return null;
  if (state.codeChangeIds.length > 0) return null;
  if (!state.workspace?.workspaceRoot) return null;
  const mutationTools = mutationToolsForFinalization(state);
  if (mutationTools.length === 0) return null;

  try {
    applySlidingWindow(state);
    state.messages.push({
      role: "user",
      content: [
        "The Developer tool step budget is exhausted and no code-change receipt exists yet.",
        "Do not inspect more files. Use only the repository evidence already gathered.",
        "You must call exactly one mutation tool now. Return no prose.",
        "Prefer apply_patch or replace_text for existing files. Use write_file only for new files or deliberate full-file replacement.",
        "If you can identify the edit from the gathered file contents, call the mutation tool even if tests will run later.",
        "Only skip the tool call if the exact target file and edit are genuinely unknown.",
      ].join("\n"),
    });

    events.publish({
      kind: "run.event",
      correlation: { ...state.correlation },
      payload: {
        phase: "max_steps_mutation_finalization",
        stepIndex: state.stepIndex,
        llmCalls: state.llmCallIds.length,
        toolInvocations: state.toolInvocationIds.length,
        mutationTools: mutationTools.map((tool) => tool.name),
      },
    });
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
        finalization: true,
        forcedMutation: true,
      },
    });

    const llmResp = await llmRespond({
      model_alias: state.modelConfig.modelAlias,
      provider: state.modelConfig.provider,
      model: state.modelConfig.model,
      messages: state.messages,
      tools: mutationTools,
      temperature: state.modelConfig.temperature,
      max_output_tokens: mutationFinalizationMaxTokens(state),
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
            finalization: true,
            forcedMutation: true,
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
      // [trace] capture transcript fields for the bin/trace.sh viewer.
      step_index: state.stepIndex,
      prompt_messages_preview: buildPromptMessagesPreview(state.messages),
      response_text: captureResponseText(llmResp.content),
      response_tool_calls: buildResponseToolCallsPreview(llmResp.tool_calls),
    });
    state.llmCallIds.push(llmRec.id);

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

    emitAuditEvent({
      trace_id: state.correlation.traceId,
      source_service: "mcp-server",
      kind: "agent_loop.max_steps_mutation_forced",
      subject_type: "LlmCall",
      subject_id: llmRec.id,
      capability_id: state.correlation.capabilityId,
      severity: "warn",
      payload: {
        reason: "Developer stage exhausted tool steps without a code-change receipt; retried with mutation-only tools.",
        model_alias: state.modelConfig.modelAlias,
        provider: state.modelConfig.provider,
        model: state.modelConfig.model,
        input_tokens: llmResp.input_tokens,
        output_tokens: llmResp.output_tokens,
        finish_reason: llmResp.finish_reason,
        mutation_tools: mutationTools.map((tool) => tool.name),
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
        finalization: true,
        forcedMutation: true,
      },
    });

    if (llmResp.finish_reason !== "tool_call" || !llmResp.tool_calls?.length) {
      log.warn({
        trace: state.correlation.traceId,
        finishReason: llmResp.finish_reason,
        contentPreview: (llmResp.content ?? "").replace(/\s+/g, " ").slice(0, 240),
        outputTokens: llmResp.output_tokens,
        maxOutputTokens: mutationFinalizationMaxTokens(state),
      }, "[max-steps-mutation] model did not return a mutation tool call");
      return null;
    }

    state.messages.push({
      role: "assistant",
      content: JSON.stringify({ tool_calls: llmResp.tool_calls }),
    });

    const mutatedPaths: string[] = [];
    for (const tc of llmResp.tool_calls.filter((toolCall) => MUTATION_TOOL_NAMES.has(toolCall.name))) {
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
        (state.governanceMode === "human_approval_required" && risky && !state.allowAutonomousMutation);
      if (requiresApproval) {
        return await pauseForApproval(
          state,
          tc,
          desc,
          risky ? "Governance requires approval before risky or mutating tool execution." : undefined,
        );
      }

      const toolArgs = applyArgsUnmaskIfNeeded(state, tc.args ?? {});
      const result = await dispatchToolCall(
        { ...tc, args: toolArgs },
        state.fullToolDescriptors,
        state.correlation,
        undefined,
        state.workspace.workspaceRoot,
      );
      state.toolInvocationIds.push(result.record.id);
      if (result.codeChange) {
        state.codeChangeIds.push(result.codeChange.id);
        if (result.codeChange.paths_touched) {
          mutatedPaths.push(...result.codeChange.paths_touched);
        }
      }
      state.verificationReceipts.push(...enrichedReceiptsFromOutput(state, result.record.output, result.record.id, tc.name));
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
      const rawOutput = toolMessageContentForRecord(state, result.record, tc.name);
      const maskedOutput = await applyOutputMaskIfNeededAsync(state, desc, rawOutput);
      state.messages.push({
        role: "tool",
        content: maskedOutput,
        tool_call_id: tc.id,
        tool_name: tc.name,
      });
    }

    if (mutatedPaths.length === 0) return null;
    const uniqueMutatedPaths = Array.from(new Set(mutatedPaths));
    await createCheckpoint(uniqueMutatedPaths, state.stepIndex, state.correlation).catch((err) => {
      log.warn(`[checkpoint] failed to create checkpoint: ${err.message}`);
    });
    state.stepIndex += 1;
    return {
      kind: "complete",
      finalContent: [
        "Applied a code change after exhausting the Developer inspection budget.",
        `Touched paths: ${uniqueMutatedPaths.join(", ")}`,
      ].join("\n"),
      finishReason: "stop",
    };
  } catch (err) {
    log.warn({ err: (err as Error).message, trace: state.correlation.traceId }, "[max-steps-mutation] failed");
    return null;
  }
}

async function finalizeReadOnlyAfterMaxSteps(state: LoopState): Promise<LoopOutcome | null> {
  try {
    applySlidingWindow(state);
    state.messages.push({
      role: "user",
      content: [
        "The read-only tool step budget is exhausted.",
        "Do not call any more tools. Use the evidence already gathered, the compressed run history, and the original task to produce the final stage response now.",
        "If a detail is uncertain, state the assumption or gap directly instead of exploring further.",
      ].join("\n"),
    });

    events.publish({
      kind: "run.event",
      correlation: { ...state.correlation },
      payload: {
        phase: "max_steps_finalization",
        stepIndex: state.stepIndex,
        llmCalls: state.llmCallIds.length,
        toolInvocations: state.toolInvocationIds.length,
      },
    });
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
        finalization: true,
      },
    });

    const llmResp = await llmRespond({
      model_alias: state.modelConfig.modelAlias,
      provider: state.modelConfig.provider,
      model: state.modelConfig.model,
      messages: state.messages,
      tools: [],
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
            finalization: true,
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
      // [trace] capture transcript fields for the bin/trace.sh viewer.
      step_index: state.stepIndex,
      prompt_messages_preview: buildPromptMessagesPreview(state.messages),
      response_text: captureResponseText(llmResp.content),
      response_tool_calls: buildResponseToolCallsPreview(llmResp.tool_calls),
    });
    state.llmCallIds.push(llmRec.id);

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

    emitAuditEvent({
      trace_id: state.correlation.traceId,
      source_service: "mcp-server",
      kind: "agent_loop.max_steps_finalized",
      subject_type: "LlmCall",
      subject_id: llmRec.id,
      capability_id: state.correlation.capabilityId,
      severity: "warn",
      payload: {
        reason: "Read-only stage exhausted tool steps; forced a no-tools final response instead of failing empty.",
        model_alias: state.modelConfig.modelAlias,
        provider: state.modelConfig.provider,
        model: state.modelConfig.model,
        input_tokens: llmResp.input_tokens,
        output_tokens: llmResp.output_tokens,
        finish_reason: llmResp.finish_reason,
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
        finalization: true,
      },
    });

    const content = (llmResp.content ?? "").trim();
    if (!content) return null;
    state.messages.push({ role: "assistant", content });
    return {
      kind: "complete",
      finalContent: content,
      finishReason: llmResp.finish_reason === "length" ? "length" : llmResp.finish_reason === "error" ? "error" : "stop",
    };
  } catch (err) {
    log.warn({ err: (err as Error).message, trace: state.correlation.traceId }, "[max-steps-finalize] failed");
    return null;
  }
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
    // ── Phased Agent Reasoning Model (v4) ──────────────────────────────
    // Persist the phase machine across the approval pause so the resumed
    // loop re-enters the same phase with its plan, planProgress, budgets,
    // step usage, repetition counters, and fallback marker intact. Absent
    // when the run is flat-loop — the resume path treats absence as
    // "rehydrate to flat mode" for backward compatibility with legacy
    // envelopes minted before this field existed.
    phase_machine: state.phaseMachine ? {
      phase: state.phaseMachine.phase,
      plan: state.phaseMachine.plan,
      planProgress: state.phaseMachine.planProgress,
      phaseBudgets: state.phaseMachine.phaseBudgets as Record<string, number>,
      phaseStepUsage: state.phaseMachine.phaseStepUsage as Record<string, number>,
      phaseRepetitionCounters: state.phaseMachine.phaseRepetitionCounters as Record<string, { lastKey?: string; count: number }>,
      phaseViolationCount: state.phaseMachine.phaseViolationCount,
      planFromFallback: state.phaseMachine.planFromFallback,
    } : undefined,
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

  // ── Phased Agent Reasoning Model (v4) — code-change coverage report ─
  // Emit the path-coverage summary so workgraph-api's stage gate can
  // reject a run whose code changes don't match the plan's required
  // targets (the "lazy edit" failure mode where the agent edits README
  // but skips the service file). When phaseMachine is absent, coverage
  // fields are omitted so downstream consumers can detect "not a phased
  // run" cleanly.
  let codeChangeCoverage: ReturnType<typeof computeCodeChangeCoverageHelper> | undefined;
  if (state.phaseMachine) {
    codeChangeCoverage = computeCodeChangeCoverageHelper(state);
    if (codeChangeCoverage.hasRequiredCodeGap) {
      emitAuditEvent({
        trace_id: state.correlation.traceId,
        source_service: "mcp-server",
        kind: "agent.plan.required_code_gap",
        capability_id: state.correlation.capabilityId,
        severity: "warn",
        payload: {
          required: codeChangeCoverage.required,
          covered: codeChangeCoverage.covered,
          missing: codeChangeCoverage.missing,
        },
      });
    }
  }

  // M43 Slice 3 — Deterministic verification gate (config-flagged).
  // When code changed in this run we expect AT LEAST ONE verification
  // receipt — either a real one from run_test/run_command OR an explicit
  // `verification_unavailable` receipt acknowledging that no verifier
  // exists. Without either, the run lacks evidence that the changes do
  // what the task asked for. We surface a structured signal under
  // `correlation.verificationCoverage` so workgraph-side gates can
  // require NEEDS_REWORK.
  let verificationCoverage: ReturnType<typeof computeVerificationCoverage> | undefined;
  if (config.MCP_DETERMINISTIC_VERIFICATION_GATE_ENABLED) {
    verificationCoverage = computeVerificationCoverage(
      state.codeChangeIds.length,
      state.verificationReceipts,
    );
    if (verificationCoverage.gap) {
      emitAuditEvent({
        trace_id: state.correlation.traceId,
        source_service: "mcp-server",
        kind: "agent.verification.gap",
        capability_id: state.correlation.capabilityId,
        severity: "warn",
        payload: {
          codeChangeIds: state.codeChangeIds,
          message: "code changed but no verification receipt captured (run_test, run_command, or verification_unavailable)",
        },
      });
    }
  }

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
    ...(codeChangeCoverage ? { codeChangeCoverage, agentReasoningMode: "phased" } : {}),
    ...(verificationCoverage ? { verificationCoverage } : {}),
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
    // M44 — Safe defaults for token budgets. Previously these were undefined
    // when callers omitted them, which made the sliding window + tool-result
    // trim NO-OP and let a single noisy tool output (50K+ chars) blow up
    // context. Workbench sent its own values; direct/resume/laptop callers
    // got nothing. Now every caller gets a sane floor; explicit values
    // (including explicit `false` for compress) still win.
    maxToolResultChars: body.limits.maxToolResultChars ?? 8000,
    maxHistoryMessages: body.limits.maxHistoryMessages ?? 12,
    maxHistoryTokens: body.limits.maxHistoryTokens ?? 32_000,
    // Compress is safe-default true. Explicit `false` still honored.
    compressToolResults: body.limits.compressToolResults !== false,
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
    // ── Phased Agent Reasoning Model (v4) ─────────────────────────────
    // Set only when both the caller opts in via body.limits.agentReasoningMode
    // AND the server has MCP_AGENT_PHASES_ENABLED. Otherwise undefined and
    // the runtime helpers all no-op.
    phaseMachine: initPhaseMachine(
      body.limits.agentReasoningMode,
      body.limits.phaseBudgets as PhaseBudgets | undefined,
    ),
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
    // M44 — same safe-default floor as the fresh-invoke path. Resume from a
    // pause should never come back with weaker limits than the original run
    // (and shouldn't blow up context if an old envelope predates the field).
    maxToolResultChars: env.max_tool_result_chars ?? 8000,
    maxHistoryMessages: env.max_history_messages ?? 12,
    maxHistoryTokens: env.max_history_tokens ?? 32_000,
    compressToolResults: env.compress_tool_results !== false,
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
    // ── Phased Agent Reasoning Model (v4) — rehydrate phase machine ──
    // Backward-compat: if env.phase_machine is absent (legacy envelope
    // minted before this field existed), keep phaseMachine undefined so
    // the run resumes in flat-loop mode without crashing. If present,
    // restore the typed shape so the loop can continue from its
    // pre-pause phase + progress.
    phaseMachine: env.phase_machine
      ? {
          phase: env.phase_machine.phase as Phase,
          plan: env.phase_machine.plan as Plan | null,
          planProgress: env.phase_machine.planProgress as PlanProgress,
          phaseBudgets: (env.phase_machine.phaseBudgets ?? DEFAULT_PHASE_BUDGETS) as PhaseBudgets,
          phaseStepUsage: env.phase_machine.phaseStepUsage as Record<Phase, number>,
          phaseRepetitionCounters: env.phase_machine.phaseRepetitionCounters as Record<Phase, { lastKey?: string; count: number }>,
          phaseViolationCount: env.phase_machine.phaseViolationCount,
          planFromFallback: env.phase_machine.planFromFallback,
        }
      : undefined,
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
    state.verificationReceipts.push(...enrichedReceiptsFromOutput(state, result.record.output, result.record.id, tc.name));
    // M39 / M39.B — mask resumed-tool output (async path for NER support).
    const resumeDesc = env.full_tool_descriptors.find((d) => d.name === tc.name);
    const rawOutput = toolMessageContentForRecord(state, result.record, tc.name);
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

/**
 * M44 Slice E — Collapse consecutive identical breadcrumb lines into a
 * single "line (x N)" entry. The model wastes context reading repeated
 * identical attempts AND loses the signal that it's stuck in a loop.
 * Dedup surfaces the repetition while saving breadcrumb capacity.
 *
 * The "x N" suffix is stripped before comparison so the function is
 * idempotent — running it twice doesn't double-multiply the count.
 *
 * Exported for testability.
 */
const DEDUP_SUFFIX_RE = /\s*\(x\s*\d+\)\s*$/;

export function dedupConsecutiveBreadcrumbs(lines: ReadonlyArray<string>): string[] {
  if (lines.length === 0) return [];
  const stripCount = (s: string): string => s.replace(DEDUP_SUFFIX_RE, "");
  const out: string[] = [];
  let lastKey: string | null = null;
  let runCount = 0;
  for (const line of lines) {
    const key = stripCount(line);
    if (key === lastKey) {
      runCount += (line.match(DEDUP_SUFFIX_RE)?.[0].match(/\d+/)?.[0]
        ? Number(line.match(/\d+/)?.[0])
        : 1);
      out[out.length - 1] = `${key} (x${runCount})`;
    } else {
      out.push(line);
      lastKey = key;
      runCount = line.match(DEDUP_SUFFIX_RE)?.[0]
        ? Number(line.match(/\d+/)?.[0] ?? 1)
        : 1;
    }
  }
  return out;
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

/**
 * [trace] Build a compact preview of the prompt messages for the audit log.
 * Captures the LAST N messages (the recent context the model actually saw)
 * with role + truncated content. Earlier messages are dropped — pin them via
 * the breadcrumb system if you need them in the trace. Per-message content
 * is capped at ~400 chars so a JSONL line stays under a few KB even with 8+
 * messages in the window.
 */
function buildPromptMessagesPreview(
  messages: ReadonlyArray<{ role: string; content?: unknown; tool_call_id?: string; tool_name?: string }>,
  windowSize = 8,
  perMessageMax = 400,
): LlmCallRecord["prompt_messages_preview"] {
  const tail = messages.slice(-windowSize);
  return tail.map((m) => {
    const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    const trimmed = raw.length > perMessageMax ? raw.slice(0, perMessageMax) + `…[+${raw.length - perMessageMax}ch]` : raw;
    const out: { role: string; content_preview: string; tool_call_id?: string; tool_name?: string } = {
      role: m.role,
      content_preview: trimmed.replace(/\s+/g, " "),
    };
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.tool_name) out.tool_name = m.tool_name;
    return out;
  });
}

/**
 * [trace] Build a compact summary of the tool_calls the model emitted in
 * this turn. Mirrors the [agent-step] log shape so the JSONL trace and the
 * stdout log share vocabulary.
 */
function buildResponseToolCallsPreview(
  toolCalls: ReadonlyArray<{ name: string; args?: Record<string, unknown> }> | undefined,
): LlmCallRecord["response_tool_calls"] {
  if (!toolCalls?.length) return undefined;
  return toolCalls.map((tc) => ({
    name: tc.name,
    args_preview: briefArgs(tc.args),
  }));
}

/** [trace] Truncate the model's text response for the audit log. */
function captureResponseText(content: unknown, max = 2000): string | undefined {
  if (content == null) return undefined;
  const s = typeof content === "string" ? content : JSON.stringify(content);
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) + `…[+${s.length - max}ch]` : s;
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

export function applySlidingWindow(state: LoopState): void {
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

  const latestToolExchange = splitLatestToolExchange(rollingMessages);
  let historicalRolling = latestToolExchange
    ? rollingMessages.slice(0, latestToolExchange.start)
    : rollingMessages;
  const pinnedLatestExchange = latestToolExchange?.messages ?? [];

  // Always strip leading orphan tool messages from rolling. A tool message
  // without a preceding assistant tool_use produces an Anthropic 400:
  // "tool_result block must have a corresponding tool_use". Once we pin
  // anchor + breadcrumb (both user role) ahead of rolling, Anthropic merges
  // consecutive user messages and any leading tool_result becomes an
  // orphan content block in message 0. Unconditional — applies even when
  // no trim happened — because rolling can start with a tool message via
  // context-fabric history or via the resume path. If this empties rolling,
  // that's fine: anchor + breadcrumb still constitute a valid first message.
  historicalRolling = dropLeadingOrphanToolMessages(historicalRolling);

  if (state.maxHistoryMessages) {
    // Reserve slots for the pinned anchor, breadcrumb, and newest tool exchange.
    // The newest exchange is deliberately not counted as droppable history: if
    // we remove the latest tool results, the model forgets what it just learned
    // and tends to repeat the same discovery calls until max_steps.
    const willHaveBreadcrumb = state.breadcrumbs.length > 0 ||
      historicalRolling.length + pinnedLatestExchange.length > state.maxHistoryMessages;
    const reserved = (anchorMessage ? 1 : 0) + (willHaveBreadcrumb ? 1 : 0) + pinnedLatestExchange.length;
    const historicalCap = Math.max(0, state.maxHistoryMessages - reserved);
    if (historicalRolling.length > historicalCap) {
      historicalRolling = historicalCap > 0
        ? dropLeadingOrphanToolMessages(historicalRolling.slice(-historicalCap))
        : [];
    }
  }

  if (state.maxHistoryTokens) {
    const anchorArr = anchorMessage ? [anchorMessage] : [];
    const tentativeBreadcrumb = state.breadcrumbs.length > 0 ? [buildBreadcrumbMessage(state.breadcrumbs)] : [];
    let combined = [...systemMessages, ...anchorArr, ...tentativeBreadcrumb, ...historicalRolling, ...pinnedLatestExchange];
    while (historicalRolling.length > 0 && estimateLoopInputTokens({ ...state, messages: combined }) > state.maxHistoryTokens) {
      const candidate = dropLeadingOrphanToolMessages(historicalRolling.slice(1));
      if (candidate.length === historicalRolling.length) break; // no progress
      historicalRolling = candidate;
      combined = [...systemMessages, ...anchorArr, ...tentativeBreadcrumb, ...historicalRolling, ...pinnedLatestExchange];
    }
  }

  // Defense-in-depth: scan rolling for *mid-sequence* orphan tool messages
  // (tool_result whose tool_use_id isn't emitted by an earlier assistant
  // turn in this rolling window). These can leak in via context-fabric
  // history or after re-plan paths. Anthropic rejects them just as hard.
  rollingMessages = removeOrphanedToolResults([...historicalRolling, ...pinnedLatestExchange]);
  // Symmetric pass: when a sliding-window trim drops a tool_result but keeps
  // the assistant message that emitted the matching tool_use, Anthropic
  // rejects the next call with "tool_use ids were found without tool_result
  // blocks immediately after". Pad each unmatched tool_use with a synthetic
  // `kind: "elided"` tool_result so the invariant holds. See padOrphanedToolUses.
  rollingMessages = padOrphanedToolUses(rollingMessages);

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
      // M44 Slice E — deduplicate consecutive identical breadcrumbs.
      // The original loop would faithfully record every rejected attempt
      // ("- read_file(path=Foo.java) -> ok" 5 times in a row), wasting both
      // breadcrumb capacity AND signal — the model has no way to see it's
      // looping. Collapse runs of the same line into "x N" so the breadcrumb
      // both saves space AND surfaces the repetition.
      state.breadcrumbs = dedupConsecutiveBreadcrumbs(
        [...state.breadcrumbs, ...newLines],
      ).slice(-MAX_BREADCRUMB_LINES);
    }
  }

  const finalBreadcrumb = state.breadcrumbs.length > 0 ? buildBreadcrumbMessage(state.breadcrumbs) : null;
  state.messages = [
    ...systemMessages,
    ...(anchorMessage ? [anchorMessage] : []),
    ...(finalBreadcrumb ? [finalBreadcrumb] : []),
    ...rollingMessages,
  ];
  // Final safety net: also pad orphan tool_uses across the FULL combined
  // window. The earlier pad happened on the rolling slice only; this catches
  // edge cases where messages got reordered (e.g. breadcrumb insertion split
  // an assistant ↔ tool_result pair).
  state.messages = padOrphanedToolUses(state.messages);
  const afterTokens = state.messages.reduce((sum, msg) => sum + estimateTextTokens(msg.content), 0);
  const dropped = Math.max(0, beforeMessages - state.messages.length);
  if (dropped > 0) {
    state.contextCompression.messagesDropped += dropped;
    state.contextCompression.tokensDropped += Math.max(0, beforeTokens - afterTokens);
  }
}

function splitLatestToolExchange(messages: ChatMessage[]): { start: number; messages: ChatMessage[] } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const ids = assistantToolCallIds(msg);
    if (ids.length === 0) continue;

    const expected = new Set(ids);
    const exchange = [msg];
    let sawToolResult = false;
    let completeSuffix = true;
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (next.role !== "tool" || !next.tool_call_id || !expected.has(next.tool_call_id)) {
        completeSuffix = false;
        break;
      }
      exchange.push(next);
      sawToolResult = true;
    }
    if (completeSuffix && sawToolResult) return { start: i, messages: exchange };
  }
  return null;
}

function assistantToolCallIds(msg: ChatMessage): string[] {
  try {
    const parsed = JSON.parse(msg.content || "{}");
    if (!parsed || !Array.isArray(parsed.tool_calls)) return [];
    return parsed.tool_calls
      .map((c: { id?: unknown }) => c.id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
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
      for (const id of assistantToolCallIds(msg)) knownIds.add(id);
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

/**
 * Symmetric to removeOrphanedToolResults: when an assistant message emits a
 * tool_use block whose matching tool_result has been dropped from the window
 * (sliding-window compression, mid-batch approval pause, mid-batch error),
 * Anthropic rejects the next LLM call with HTTP 400:
 *   "`tool_use` ids were found without `tool_result` blocks immediately after".
 *
 * Fix: scan each assistant message's tool_use IDs and, for any whose
 * tool_result is missing in the immediately-following tool-message run,
 * synthesize a placeholder tool_result with `kind:"elided"`. The placeholder
 * carries no fabricated data — it just satisfies the Anthropic invariant so
 * the conversation can continue. The agent can interpret "elided" as
 * "previous result no longer available" and re-fetch if it still cares.
 */
function padOrphanedToolUses(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    out.push(msg);
    if (msg.role !== "assistant") continue;
    const expectedIds = assistantToolCallIds(msg);
    if (expectedIds.length === 0) continue;
    // Walk through any tool messages that immediately follow this assistant
    // turn, collect the tool_call_ids they cover, and emit them in order.
    const seen = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const tid = messages[j].tool_call_id;
      if (typeof tid === "string") seen.add(tid);
      out.push(messages[j]);
      j++;
    }
    // Synthesize a placeholder tool_result for any expected ID that didn't
    // show up in the run of tool messages above.
    for (const expectedId of expectedIds) {
      if (seen.has(expectedId)) continue;
      out.push({
        role: "tool",
        tool_call_id: expectedId,
        tool_name: "elided",
        content: JSON.stringify({
          kind: "elided",
          reason: "Prior tool result is no longer in the context window. If the result still matters, re-issue the tool call.",
        }),
      });
    }
    // Skip past the tool messages we already pushed.
    i = j - 1;
  }
  return out;
}

function toolResultForNextTurn(state: LoopState, output: unknown, toolName?: string): string {
  const raw = JSON.stringify(output);
  if (!state.compressToolResults) return trimToolResult(raw, state.maxToolResultChars);

  // M44 Slice D — try tool-aware summary first (knows the shape, can keep
  // the signal-bearing parts and drop noise). Falls back to the generic
  // compactor when the tool doesn't have a specialized summarizer.
  const summarized = toolName ? toolAwareSummary(toolName, output) : null;
  const compressed = JSON.stringify(summarized ?? compactToolResult(output));
  const selected = compressed.length < raw.length ? compressed : raw;
  if (selected.length < raw.length) {
    state.contextCompression.toolResultsCompressed += 1;
    state.contextCompression.toolResultBytesSaved += raw.length - selected.length;
  }
  return trimToolResult(selected, state.maxToolResultChars);
}

/**
 * Build the tool-message content shown to the LLM.
 *
 * Critical: when a tool fails (e.g. `run_command` rejected for shell operators,
 * argument validation error, server timeout) the record carries the error text
 * in `record.error` while `record.output` is `null`. Previously the LLM only
 * saw `JSON.stringify(null)` → "null" and had no way to learn _why_ the call
 * failed, so it would keep retrying broken commands. Surfacing the error +
 * error_code into the tool message lets the model self-correct on the next
 * step (e.g. swap `find . -name '*.java' | head` → `list_directory(src/)`).
 *
 * Format mirrors a structured payload the LLM can reason about:
 *   {"error":"shell operators are not allowed; ...", "error_code":"...", "success":false}
 */
function toolMessageContentForRecord(
  state: LoopState,
  record: { output: unknown; success?: boolean; error?: string | null; error_code?: string | null },
  toolName?: string,
): string {
  if (record.success === false) {
    const errorPayload: Record<string, unknown> = {
      success: false,
      error: record.error ?? "tool invocation failed without an error message",
    };
    if (record.error_code) errorPayload.error_code = record.error_code;
    if (record.output !== null && record.output !== undefined) errorPayload.output = record.output;
    return trimToolResult(JSON.stringify(errorPayload), state.maxToolResultChars);
  }
  return toolResultForNextTurn(state, record.output, toolName);
}

/**
 * M44 Slice D — Tool-aware compression. The generic compactToolResult below
 * is too conservative for shape-heavy tool outputs (search_code, list_directory,
 * file_stats, command output). This function knows specific tool shapes and
 * keeps the signal-bearing parts (paths, line numbers, exit codes, top-N
 * matches) while dropping the bulk (full match snippets, long stdout tails,
 * unused metadata).
 *
 * Returns null when the tool isn't recognized — caller falls back to
 * compactToolResult for generic JSON minification.
 *
 * Exported for testability via __testing.
 */
export function toolAwareSummary(toolName: string, output: unknown): unknown | null {
  if (!output || typeof output !== "object") return null;
  const out = output as Record<string, unknown>;

  switch (toolName) {
    case "read_file": {
      // Keep first N + last N lines plus a marker. Full file body is rarely
      // needed in the next turn — model can re-read if it is.
      const content = typeof out.content === "string" ? out.content : null;
      if (content === null || content.length < 1200) return null;
      const lines = content.split("\n");
      if (lines.length < 60) return null;
      const head = lines.slice(0, 30).join("\n");
      const tail = lines.slice(-15).join("\n");
      return {
        ...out,
        content_excerpt: `${head}\n... [${lines.length - 45} lines elided, full file was ${content.length} chars] ...\n${tail}`,
        content: undefined,
        original_lines: lines.length,
        original_chars: content.length,
      };
    }

    case "search_code":
    case "grep_lines": {
      // Keep at most 8 matches with their line numbers + 1 line of context.
      // Drop verbose excerpts beyond that.
      const matches = Array.isArray(out.matches) ? out.matches : Array.isArray(out.results) ? out.results : null;
      if (!Array.isArray(matches) || matches.length <= 8) return null;
      return {
        ...out,
        matches: matches.slice(0, 8),
        truncated_matches: matches.length - 8,
        total_matches: matches.length,
      };
    }

    case "list_directory": {
      // Cap entries; keep counts so the model knows how big the dir is.
      const entries = Array.isArray(out.entries) ? out.entries : null;
      if (!Array.isArray(entries) || entries.length <= 40) return null;
      return {
        ...out,
        entries: entries.slice(0, 40),
        truncated_entries: entries.length - 40,
        total_entries: entries.length,
      };
    }

    case "list_indexed_files":
    case "find_files": {
      const files = Array.isArray(out.files) ? out.files : null;
      if (!Array.isArray(files) || files.length <= 20) return null;
      return {
        ...out,
        files: files.slice(0, 20),
        truncated_files: files.length - 20,
        total_files: files.length,
      };
    }

    case "run_command":
    case "run_test": {
      // Verification output — keep stdout head + tail + exit code. Stdout
      // is often where the failure signal lives; preserve both ends.
      const stdout = typeof out.stdout === "string" ? out.stdout : "";
      const stderr = typeof out.stderr === "string" ? out.stderr : "";
      if (stdout.length + stderr.length < 3000) return null;
      const head = stdout.slice(0, 1500);
      const tail = stdout.length > 3000 ? stdout.slice(-800) : "";
      return {
        ...out,
        stdout_head: head,
        stdout_tail: tail || undefined,
        stdout_chars: stdout.length,
        stderr: stderr.length > 1000 ? `${stderr.slice(0, 600)}\n... [${stderr.length - 600} stderr chars elided]` : stderr,
        stdout: undefined,
      };
    }

    case "get_dependencies": {
      // Imports lists can be long; keep counts + head.
      const deps = Array.isArray(out.dependencies) ? out.dependencies : null;
      if (!Array.isArray(deps) || deps.length <= 25) return null;
      return {
        ...out,
        dependencies: deps.slice(0, 25),
        truncated_dependencies: deps.length - 25,
        total_dependencies: deps.length,
      };
    }

    default:
      return null;
  }
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

/**
 * POST /mcp/pending/clear — invalidate pending approvals tied to a workflow
 * run or trace prefix. Called by workgraph-api during a stage send-back so
 * the new attempt doesn't inherit stale "Approve MCP action…" prompts from
 * the previous run.
 *
 * Body: { tracePrefix?: string, workflowInstanceId?: string, sessionId?: string }
 * Selectors are AND-ed. Returns the count of cleared tokens.
 */
invokeRouter.post("/pending/clear", (req, res) => {
  const parsed = z.object({
    tracePrefix: z.string().min(1).optional(),
    workflowInstanceId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  }).refine(
    v => v.tracePrefix || v.workflowInstanceId || v.sessionId,
    { message: "must provide at least one selector: tracePrefix, workflowInstanceId, or sessionId" },
  ).safeParse(req.body);
  if (!parsed.success) {
    throw new AppError("invalid /mcp/pending/clear payload", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }
  const result = clearPending(parsed.data);
  log.info({ ...parsed.data, cleared: result.cleared }, "[mcp-server] cleared pending approvals");
  res.json({
    success: true,
    data: { cleared: result.cleared, cleared_tokens: result.cleared_tokens },
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
