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
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { config } from "../config";
import { log } from "../shared/log";
import { AppError, NotFoundError } from "../shared/errors";
import { llmRespond } from "../llm/client";
import { ChatMessage, LlmResponse, ToolCall, ToolDescriptorForLlm } from "../llm/types";
import { resolveModelConfig } from "../llm/model-catalog";
import { getLocalTool, listLocalTools } from "../tools/registry";
import {
  CorrelationIds, recordLlmCall, recordToolInvocation, recordArtifact,
  recordCodeChange, ToolInvocationRecord, CodeChangeRecord,
} from "../audit/store";
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
} from "../workspace/git-workspace";
import { indexWorkspace, lastAstStats } from "../workspace/ast-index";
import { ensureWorkspaceSource, WorkspaceSourceStatus } from "../workspace/source-materializer";
import { sandboxRoot, withSandboxRoot, workspaceRootForRunContext } from "../workspace/sandbox";

const ToolDescSchema = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.unknown()),
  execution_target: z.enum(["LOCAL", "SERVER"]).default("LOCAL"),
  version: z.string().optional(),
  natural_language: z.string().optional(),
  risk_level: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  requires_approval: z.boolean().optional(),
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
    provider: z.string().optional(),
    model: z.string().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int().optional(),
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
    sourceType: z.string().optional(),
    sourceUri: z.string().optional(),
    sourceRef: z.string().optional(),
  }).default({}),
  limits: z.object({
    maxSteps: z.number().int().positive().optional(),
    timeoutSec: z.number().int().positive().optional(),
    maxToolResultChars: z.number().int().positive().optional(),
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
    provider: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    warnings?: string[];
  };
  correlation: CorrelationIds;
  stepIndex: number;
  maxSteps: number;
  maxToolResultChars?: number;
  llmCallIds: string[];
  toolInvocationIds: string[];
  artifactIds: string[];
  codeChangeIds: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
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
  };
  governanceMode: GovernanceMode;
  contextPlanHash?: string;
  degradedActionsAllowed: string[];
  allowAutonomousMutation: boolean;
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

function shouldNudgeForCodeToolUse(state: LoopState, llmResp: LlmResponse): boolean {
  if (!state.allowAutonomousMutation || state.toolUseNudgeCount >= 1) return false;
  if (llmResp.finish_reason === "tool_call" && llmResp.tool_calls?.length) return false;
  if (!state.workspace?.workspaceRoot) return false;
  const hasInspectionTools = hasTool(state, ["find_symbol", "get_symbol", "get_ast_slice", "get_dependencies", "search_code", "read_file"]);
  const hasMutationTools = hasTool(state, ["apply_patch", "write_file", "git_commit", "finish_work_branch"]);
  return hasInspectionTools && hasMutationTools;
}

function appendCodeToolUseNudge(state: LoopState, llmResp: LlmResponse): void {
  if (llmResp.content) {
    state.messages.push({
      role: "assistant",
      content: llmResp.content,
    });
  }
  state.messages.push({
    role: "user",
    content: [
      "This is a Developer stage with a writable MCP workspace, but the previous answer did not call any tools.",
      "Use MCP tools now before answering in prose.",
      "Inspect the code with find_symbol, get_symbol, get_ast_slice, search_code, or read_file.",
      "Apply the requested change with apply_patch or write_file, then create code-change evidence with git_commit or finish_work_branch.",
      "Do not call prepare_work_branch; the workflow branch is already prepared.",
      "If the behavior already exists, add or update tests/documentation and commit that evidence.",
    ].join("\n"),
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
      latency_ms: llmResp.latency_ms,
      prompt_messages_count: state.messages.length,
      finish_reason: llmResp.finish_reason,
    });
    state.llmCallIds.push(llmRec.id);

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
        latency_ms:    llmResp.latency_ms,
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
        latency_ms: llmResp.latency_ms,
        tool_calls_count: llmResp.tool_calls?.length ?? 0,
      },
    });

    if (llmResp.finish_reason === "tool_call" && llmResp.tool_calls?.length) {
      // Record the assistant turn so resumed conversations stay coherent.
      state.messages.push({
        role: "assistant",
        content: JSON.stringify({ tool_calls: llmResp.tool_calls }),
      });

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
          (state.governanceMode === "human_approval_required" && risky);

        if (requiresApproval) {
          return await pauseForApproval(
            state,
            tc,
            desc,
            risky ? "Governance requires approval before risky or mutating tool execution." : undefined,
          );
        }

        // Normal dispatch path.
        const result = await dispatchToolCall(
          tc,
          state.fullToolDescriptors,
          state.correlation,
          undefined,
          state.workspace?.workspaceRoot,
        );
        state.toolInvocationIds.push(result.record.id);
        if (result.codeChange) state.codeChangeIds.push(result.codeChange.id);
        if (result.approvalRequired) {
          return await pauseForApproval(state, tc, desc, result.approvalRequired.reason, result.record.id);
        }
        state.messages.push({
          role: "tool",
          content: trimToolResult(JSON.stringify(result.record.output), state.maxToolResultChars),
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
      state.stepIndex += 1;
      continue;
    }

    if (shouldNudgeForCodeToolUse(state, llmResp)) {
      appendCodeToolUseNudge(state, llmResp);
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
    workspace: state.workspace,
    total_input_tokens: state.totalInputTokens,
    total_output_tokens: state.totalOutputTokens,
    governance_mode: state.governanceMode,
    context_plan_hash: state.contextPlanHash,
    degraded_actions_allowed: state.degradedActionsAllowed,
    allow_autonomous_mutation: state.allowAutonomousMutation,
    tool_use_nudge_count: state.toolUseNudgeCount,
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

  if (outcome.kind === "complete") {
    if (state.workspace?.branch) {
      const finish = await finishWorkBranch(
        `Singularity work item ${state.correlation.workItemId ?? state.workspace.branch.branch}`,
        {
          push: config.MCP_WORK_BRANCH_PUSH_ON_FINISH,
          remote: config.MCP_WORK_BRANCH_PUSH_REMOTE,
        },
      );
      const stats = await indexWorkspace("auto_finish");
      state.workspace.commitSha = finish.commitSha;
      state.workspace.changedPaths = finish.changedPaths;
      state.workspace.workspaceRoot = finish.workspaceRoot ?? state.workspace.workspaceRoot ?? sandboxRoot();
      state.workspace.astIndexStatus = stats.status;
      state.workspace.astIndexedFiles = stats.indexedFiles;
      state.workspace.astIndexedSymbols = stats.indexedSymbols;
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
    finalContent = outcome.finalContent;
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
    : outcome.finishReason === "max_steps" ? "FAILED"
    : "COMPLETED";

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
    },
    modelUsage: {
      modelAlias: state.modelConfig.modelAlias,
      provider: state.modelConfig.provider,
      model: state.modelConfig.model,
      warnings: state.modelConfig.warnings ?? [],
      inputTokens: state.totalInputTokens,
      outputTokens: state.totalOutputTokens,
      totalTokens: state.totalInputTokens + state.totalOutputTokens,
    },
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
  });

  return await withSandboxRoot(workspaceRoot, async () => {
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
    });
  }
  const toolList = Array.from(mergedTools.values());

  const messages: ChatMessage[] = [];
  if (body.systemPrompt) messages.push({ role: "system", content: body.systemPrompt });
  if (toolList.some((tool) => ["find_symbol", "get_symbol", "get_ast_slice", "get_dependencies"].includes(tool.name))) {
    messages.push({
      role: "system",
      content: [
        "Local code intelligence policy:",
        "- For code inspection or edits, use AST tools before full-file reads.",
        "- Start with find_symbol or get_dependencies, then get_symbol for signatures and summaries.",
        "- Use get_ast_slice for exact source ranges. Use read_file only when a full file is explicitly needed.",
        "- Keep private workspace code local; report summaries, slices, changed paths, branch, commit SHA, and receipts.",
      ].join("\n"),
    });
  }
  if (
    body.allowAutonomousMutation === true &&
    toolList.some((tool) => ["apply_patch", "write_file", "git_commit", "finish_work_branch"].includes(tool.name))
  ) {
    messages.push({
      role: "system",
      content: [
        "Developer stage tool policy:",
        "- This run is expected to produce real MCP/git code-change evidence.",
        "- Do not provide only a narrative implementation plan.",
        "- Inspect the workspace with MCP code tools, modify files with apply_patch or write_file, and finish with git_commit or finish_work_branch.",
        "- If no source change is needed, commit test or documentation evidence that proves the requested behavior.",
      ].join("\n"),
    });
  }
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
  }));

  const resolvedModel = resolveModelConfig({
    modelAlias: body.modelConfig.modelAlias,
    provider: body.modelConfig.provider,
    model: body.modelConfig.model,
    temperature: body.modelConfig.temperature,
    maxTokens: body.modelConfig.maxTokens,
  });

  const state: LoopState = {
    messages,
    availableTools,
    fullToolDescriptors,
    modelConfig: resolvedModel,
    correlation,
    stepIndex: 0,
    maxSteps: body.limits.maxSteps ?? config.MAX_AGENT_STEPS,
    maxToolResultChars: body.limits.maxToolResultChars,
    llmCallIds: [],
    toolInvocationIds: [],
    artifactIds: [],
    codeChangeIds: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
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
  };

  const outcome = await runLoop(state);
  return buildResponseBody(state, outcome, startedAt);
  });
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
  await withSandboxRoot(resumeWorkspaceRoot, async () => {
  const state: LoopState = {
    messages: env.messages,
    availableTools: env.available_tools,
    fullToolDescriptors: env.full_tool_descriptors,
    modelConfig: env.model_config,
    correlation: env.correlation,
    stepIndex: env.step_index,
    maxSteps: env.max_steps,
    maxToolResultChars: env.max_tool_result_chars,
    llmCallIds: env.llm_call_ids,
    toolInvocationIds: env.tool_invocation_ids,
    artifactIds: env.artifact_ids,
    codeChangeIds: env.code_change_ids ?? [],
    // Resumed loops start with a fresh history — the repetition detector
    // only meaningfully fires on consecutive identical calls within a single
    // invocation, not across approval pauses.
    toolCallHistory: [],
    toolUseNudgeCount: env.tool_use_nudge_count ?? 0,
    workspace: env.workspace,
    totalInputTokens: env.total_input_tokens,
    totalOutputTokens: env.total_output_tokens,
    governanceMode: env.governance_mode ?? "fail_open",
    contextPlanHash: env.context_plan_hash,
    degradedActionsAllowed: env.degraded_actions_allowed ?? [],
    allowAutonomousMutation: env.allow_autonomous_mutation === true,
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
  const args = body.args_override ?? tc.args;

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
      content: trimToolResult(JSON.stringify({
        status: "approval_rejected",
        reason: body.reason ?? "operator rejected the request",
      }), state.maxToolResultChars),
      tool_call_id: tc.id,
      tool_name: tc.name,
    });
  } else {
    // Approved — execute the tool and append the result.
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
    state.messages.push({
      role: "tool",
      content: trimToolResult(JSON.stringify(result.record.output), state.maxToolResultChars),
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
  });
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

function trimToolResult(content: string, maxChars?: number): string {
  if (!maxChars || content.length <= maxChars) return content;
  return `${content.slice(0, Math.max(0, maxChars - 80))}\n...[tool result trimmed to ${maxChars} chars]`;
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
    events.publish({
      kind: "tool.invocation.updated",
      correlation: { ...correlation, toolInvocationId: rec.id },
      severity,
      payload: {
        tool_name: rec.tool_name, success: rec.success, error: rec.error,
        latency_ms: rec.latency_ms,
      },
    });
    // M21 — fire-and-forget to audit-governance
    emitAuditEvent({
      trace_id:      correlation.traceId,
      source_service: "mcp-server",
      kind:          "tool.invocation.completed",
      subject_type:  "ToolInvocation",
      subject_id:    rec.id,
      capability_id: correlation.capabilityId,
      severity:      rec.success ? "info" : "warn",
      payload: {
        tool_name:  rec.tool_name,
        success:    rec.success,
        error:      rec.error,
        latency_ms: rec.latency_ms,
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
      let body: { status?: string; error?: unknown; reason?: unknown } = {};
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
      return finishWith(
        recordToolInvocation({
          correlation,
          tool_name: tc.name,
          args: tc.args,
          output: body,
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
