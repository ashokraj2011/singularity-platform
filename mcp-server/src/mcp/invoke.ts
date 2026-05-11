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
import { ChatMessage, ToolCall, ToolDescriptorForLlm } from "../llm/types";
import { getLocalTool } from "../tools/registry";
import {
  CorrelationIds, recordLlmCall, recordToolInvocation, recordArtifact,
  recordCodeChange, ToolInvocationRecord, CodeChangeRecord,
} from "../audit/store";
import { extractCodeChange } from "../audit/provenanceExtractor";
import { events } from "../events/bus";
import { emitAuditEvent } from "../lib/audit-gov-emit";
import { checkBudget, checkRateLimit } from "../lib/audit-gov-check";
import {
  savePending, takePending, peekPending, PendingToolDescriptor,
} from "../audit/pending";

const ToolDescSchema = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.unknown()),
  execution_target: z.enum(["LOCAL", "SERVER"]).default("LOCAL"),
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
    provider: z.string().optional(),
    model: z.string().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int().optional(),
  }).default({}),
  runContext: z.object({
    sessionId: z.string().optional(),
    capabilityId: z.string().optional(),
    agentId: z.string().optional(),
    runId: z.string().optional(),
    runStepId: z.string().optional(),
    workItemId: z.string().optional(),
    traceId: z.string().optional(),
  }).default({}),
  limits: z.object({
    maxSteps: z.number().int().positive().optional(),
    timeoutSec: z.number().int().positive().optional(),
  }).default({}),
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
    provider: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
  };
  correlation: CorrelationIds;
  stepIndex: number;
  maxSteps: number;
  llmCallIds: string[];
  toolInvocationIds: string[];
  artifactIds: string[];
  codeChangeIds: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
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
      finishReason: "governance_denied";
      reason: string;
      check: "budget" | "rate_limit";
      details?: Record<string, unknown>;
    };

async function runLoop(state: LoopState): Promise<LoopOutcome> {
  while (state.stepIndex < state.maxSteps) {
    // M22 — pre-flight governance checks. Audit-gov is fail-open; only an
    // explicit `allowed:false` blocks. Both checks run in parallel.
    const [budgetRes, rateRes] = await Promise.all([
      checkBudget(state.correlation.capabilityId, undefined),
      checkRateLimit(state.correlation.capabilityId, undefined),
    ]);
    if (!budgetRes.allowed) {
      const reason = budgetRes.reason ?? "budget exhausted";
      emitAuditEvent({
        trace_id: state.correlation.traceId,
        source_service: "mcp-server",
        kind: "governance.denied",
        capability_id: state.correlation.capabilityId,
        severity: "warn",
        payload: { check: "budget", reason, budgets: budgetRes.budgets ?? [] },
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
        payload: { check: "rate_limit", reason, rate_limits: rateRes.rate_limits ?? [] },
      });
      return { kind: "denied", finishReason: "governance_denied", reason, check: "rate_limit", details: { rate_limits: rateRes.rate_limits } };
    }

    events.publish({
      kind: "llm.request",
      correlation: { ...state.correlation },
      payload: {
        provider: state.modelConfig.provider,
        model: state.modelConfig.model,
        prompt_messages_count: state.messages.length,
        stepIndex: state.stepIndex,
      },
    });

    const llmResp = await llmRespond({
      provider: state.modelConfig.provider,
      model: state.modelConfig.model,
      messages: state.messages,
      tools: state.availableTools,
      temperature: state.modelConfig.temperature,
      max_output_tokens: state.modelConfig.maxTokens,
    });
    state.totalInputTokens += llmResp.input_tokens;
    state.totalOutputTokens += llmResp.output_tokens;

    const llmRec = recordLlmCall({
      correlation: state.correlation,
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
        const requiresApproval = desc?.requires_approval || handler?.descriptor.requires_approval;

        if (requiresApproval) {
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
              risk_level: desc?.risk_level,
            },
            available_tools: state.availableTools,
            full_tool_descriptors: state.fullToolDescriptors,
            model_config: state.modelConfig,
            correlation: state.correlation,
            step_index: state.stepIndex,
            max_steps: state.maxSteps,
            llm_call_ids: state.llmCallIds,
            tool_invocation_ids: state.toolInvocationIds,
            artifact_ids: state.artifactIds,
            code_change_ids: state.codeChangeIds,
            total_input_tokens: state.totalInputTokens,
            total_output_tokens: state.totalOutputTokens,
          });
          events.publish({
            kind: "approval.wait.created",
            correlation: { ...state.correlation },
            severity: "warn",
            payload: {
              continuation_token: env.continuation_token,
              tool_name: tc.name,
              tool_args: tc.args,
              risk_level: desc?.risk_level,
              expires_at: env.expires_at,
            },
          });
          // M21 — register the approval in the central authority + write
          // the audit_event so the dashboard can see who's waiting.
          //
          // Production hardening will MOVE the PendingApproval store from
          // mcp-server's in-memory map into audit-governance entirely (M21.5);
          // for v0 we mirror so the surface is visible without breaking M9.z.
          void fetch(`${process.env.AUDIT_GOV_URL ?? "http://host.docker.internal:8500"}/api/v1/governance/approvals`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: env.continuation_token,
              trace_id: state.correlation.traceId,
              capability_id: state.correlation.capabilityId,
              source_service: "mcp-server",
              tool_name: tc.name,
              tool_args: tc.args,
              risk_level: desc?.risk_level,
              expires_at: env.expires_at,
            }),
            signal: AbortSignal.timeout(5_000),
          }).catch(() => { /* fire-and-forget */ });
          emitAuditEvent({
            trace_id: state.correlation.traceId,
            source_service: "mcp-server",
            kind: "approval.wait.created",
            subject_type: "Approval",
            subject_id: env.continuation_token,
            capability_id: state.correlation.capabilityId,
            severity: "warn",
            payload: {
              tool_name: tc.name,
              tool_args: tc.args,
              risk_level: desc?.risk_level,
              expires_at: env.expires_at,
            },
          });
          return {
            kind: "paused",
            continuationToken: env.continuation_token,
            pendingToolCall: tc,
            pendingDescriptor: env.pending_tool_descriptor,
            finishReason: "approval_required",
          };
        }

        // Normal dispatch path.
        const result = await dispatchToolCall(tc, state.fullToolDescriptors, state.correlation);
        state.toolInvocationIds.push(result.record.id);
        if (result.codeChange) state.codeChangeIds.push(result.codeChange.id);
        state.messages.push({
          role: "tool",
          content: JSON.stringify(result.record.output),
          tool_call_id: tc.id,
          tool_name: tc.name,
        });
      }
      state.stepIndex += 1;
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

function buildResponseBody(
  state: LoopState,
  outcome: LoopOutcome,
  startedAt: number,
): Record<string, unknown> {
  let finalArtifactId: string | undefined;
  let finalContent = "";

  if (outcome.kind === "complete") {
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
           : outcome.kind === "denied" ? "governance_denied"
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
      check: outcome.check,
      reason: outcome.reason,
      details: outcome.details,
    };
  }

  return out;
}

// ── POST /mcp/invoke ─────────────────────────────────────────────────────

invokeRouter.post("/invoke", async (req, res) => {
  const parsed = InvokeSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError("invalid /mcp/invoke payload", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }
  const body = parsed.data;
  const startedAt = Date.now();

  const correlation: CorrelationIds = {
    ...body.runContext,
    mcpInvocationId: uuidv4(),
  };

  const messages: ChatMessage[] = [];
  if (body.systemPrompt) messages.push({ role: "system", content: body.systemPrompt });
  for (const h of body.history) messages.push({ ...h });
  messages.push({ role: "user", content: body.message });

  const availableTools: ToolDescriptorForLlm[] = body.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  const fullToolDescriptors: PendingToolDescriptor[] = body.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    execution_target: t.execution_target,
    natural_language: t.natural_language,
    risk_level: t.risk_level,
    requires_approval: t.requires_approval,
  }));

  const state: LoopState = {
    messages,
    availableTools,
    fullToolDescriptors,
    modelConfig: {
      provider: body.modelConfig.provider ?? config.LLM_PROVIDER,
      model: body.modelConfig.model ?? config.LLM_MODEL,
      temperature: body.modelConfig.temperature,
      maxTokens: body.modelConfig.maxTokens,
    },
    correlation,
    stepIndex: 0,
    maxSteps: body.limits.maxSteps ?? config.MAX_AGENT_STEPS,
    llmCallIds: [],
    toolInvocationIds: [],
    artifactIds: [],
    codeChangeIds: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  const outcome = await runLoop(state);
  res.json({
    success: true,
    data: buildResponseBody(state, outcome, startedAt),
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

  const env = takePending(body.continuation_token);  // single-use
  if (!env) throw new NotFoundError(`continuation_token not found or already consumed: ${body.continuation_token}`);

  const state: LoopState = {
    messages: env.messages,
    availableTools: env.available_tools,
    fullToolDescriptors: env.full_tool_descriptors,
    modelConfig: env.model_config,
    correlation: env.correlation,
    stepIndex: env.step_index,
    maxSteps: env.max_steps,
    llmCallIds: env.llm_call_ids,
    toolInvocationIds: env.tool_invocation_ids,
    artifactIds: env.artifact_ids,
    codeChangeIds: env.code_change_ids ?? [],
    totalInputTokens: env.total_input_tokens,
    totalOutputTokens: env.total_output_tokens,
  };

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
      content: JSON.stringify({
        status: "approval_rejected",
        reason: body.reason ?? "operator rejected the request",
      }),
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
    );
    state.toolInvocationIds.push(result.record.id);
    if (result.codeChange) state.codeChangeIds.push(result.codeChange.id);
    state.messages.push({
      role: "tool",
      content: JSON.stringify(result.record.output),
      tool_call_id: tc.id,
      tool_name: tc.name,
    });
  }
  state.stepIndex += 1;

  const outcome = await runLoop(state);
  res.json({
    success: true,
    data: buildResponseBody(state, outcome, startedAt),
    requestId: res.locals.requestId,
  });
});

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
): Promise<{ record: ToolInvocationRecord; codeChange?: CodeChangeRecord }> {
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
    return finishWith(
      recordToolInvocation({
        correlation, tool_name: tc.name, args: tc.args, output: null,
        success: false, error: "execution_target=SERVER tools not implemented in v0",
        latency_ms: Date.now() - start,
      }),
      "error",
    );
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
    const r = await handler.execute(tc.args);
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
