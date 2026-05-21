import { Router } from "express";
import { NotFoundError } from "../shared/errors";
import { audit } from "../audit/store";

export const resourcesRouter = Router();

/**
 * GET /mcp/resources/{kind}            list recent
 * GET /mcp/resources/{kind}/{id}       fetch one
 * GET /mcp/resources/by-trace/{traceId}  cross-kind timeline
 *
 * Kinds (PLAN_mcp.md §4):
 *   tool-invocations    — durable invocation record
 *   llm-calls           — provider/model/tokens/latency
 *   artifacts           — final responses, generic patches, etc.
 *   code-changes        — M13. Structured code-change records produced by the
 *                         provenance extractor (paths_touched, diff, patch,
 *                         commit_sha). Joined to a tool invocation via
 *                         correlation.toolInvocationId.
 *
 * v1 will still add: prompt-receipts, llm-context-log, run-events.
 */
resourcesRouter.get("/resources/by-trace/:traceId", (req, res) => {
  const t = req.params.traceId;
  res.json({
    success: true,
    data: {
      traceId: t,
      llm_calls: audit.llmCalls.byTraceId(t),
      tool_invocations: audit.toolInvocations.byTraceId(t),
      artifacts: audit.artifacts.byTraceId(t),
    },
    requestId: res.locals.requestId,
  });
});

// M28 spine-2 — server-side `?trace_id=…&limit=N` filtering on all list
// endpoints. Prior to 2026-05-14 these list routes were `(_req, res) => …`
// and silently ignored every query param — `bin/test-trace-spine.sh` exists
// specifically to make that regression impossible to ship.
resourcesRouter.get("/resources/llm-calls", (req, res) => {
  const traceId = typeof req.query.trace_id === "string" ? req.query.trace_id : undefined;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const items = traceId
    ? audit.llmCalls.byTraceId(traceId).slice(0, limit)
    : audit.llmCalls.recent(limit);
  res.json({ success: true, data: { items, total: items.length, traceId: traceId ?? null }, requestId: res.locals.requestId });
});
resourcesRouter.get("/resources/llm-calls/:id", (req, res) => {
  const r = audit.llmCalls.byId(req.params.id);
  if (!r) throw new NotFoundError(`llm_call ${req.params.id} not found`);
  res.json({ success: true, data: r, requestId: res.locals.requestId });
});

resourcesRouter.get("/resources/tool-invocations", (req, res) => {
  const traceId = typeof req.query.trace_id === "string" ? req.query.trace_id : undefined;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const items = traceId
    ? audit.toolInvocations.byTraceId(traceId).slice(0, limit)
    : audit.toolInvocations.recent(limit);
  res.json({ success: true, data: { items, total: items.length, traceId: traceId ?? null }, requestId: res.locals.requestId });
});
resourcesRouter.get("/resources/tool-invocations/:id", (req, res) => {
  const r = audit.toolInvocations.byId(req.params.id);
  if (!r) throw new NotFoundError(`tool_invocation ${req.params.id} not found`);
  res.json({ success: true, data: r, requestId: res.locals.requestId });
});

resourcesRouter.get("/resources/artifacts", (req, res) => {
  const traceId = typeof req.query.trace_id === "string" ? req.query.trace_id : undefined;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const items = traceId
    ? audit.artifacts.byTraceId(traceId).slice(0, limit)
    : audit.artifacts.recent(limit);
  res.json({ success: true, data: { items, total: items.length, traceId: traceId ?? null }, requestId: res.locals.requestId });
});
resourcesRouter.get("/resources/artifacts/:id", (req, res) => {
  const r = audit.artifacts.byId(req.params.id);
  if (!r) throw new NotFoundError(`artifact ${req.params.id} not found`);
  res.json({ success: true, data: r, requestId: res.locals.requestId });
});

// ── code-changes (M13) ───────────────────────────────────────────────────
//
// `?trace_id=…` filters; `?ids=cc_a,cc_b,cc_c` returns specific records (used
// by the workgraph proxy when context-fabric resolved the ids from call_log).

resourcesRouter.get("/resources/code-changes", (req, res) => {
  const traceId = typeof req.query.trace_id === "string" ? req.query.trace_id : undefined;
  const idsCsv  = typeof req.query.ids === "string" ? req.query.ids : undefined;
  const limit   = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));

  let items;
  if (idsCsv) {
    const ids = idsCsv.split(",").map((s) => s.trim()).filter(Boolean);
    items = ids.map((id) => audit.codeChanges.byId(id)).filter((x) => x);
  } else if (traceId) {
    items = audit.codeChanges.byTraceId(traceId);
  } else {
    items = audit.codeChanges.recent(limit);
  }
  res.json({ success: true, data: { items }, requestId: res.locals.requestId });
});

resourcesRouter.get("/resources/code-changes/:id", (req, res) => {
  const r = audit.codeChanges.byId(req.params.id);
  if (!r) throw new NotFoundError(`code_change ${req.params.id} not found`);
  res.json({ success: true, data: r, requestId: res.locals.requestId });
});

// ── M45 — loop-trace timeline (Workbench Loop tab) ───────────────────────
//
// Fold the existing by-trace records into a structured timeline tailored to
// the workbench Loop tab UI. Each "step" represents one LLM call with its
// associated tool invocations attached (matched by step_index + timestamp).
// Phases are inferred from the llm_call records' phase field (set by the
// phased agent loop) and span steps. Returns enough data for the UI to
// render phase ribbon + step cards without further joins.

resourcesRouter.get("/audit/loop-trace/:traceId", (req, res) => {
  const traceId = req.params.traceId;
  const llmCalls = audit.llmCalls.byTraceId(traceId);
  const toolInvs = audit.toolInvocations.byTraceId(traceId);
  const codeChanges = audit.codeChanges.byTraceId(traceId);

  // ── steps: one per LLM call, sorted by timestamp ──
  const sortedLlmCalls = [...llmCalls].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Attach tool invocations to the LLM call that triggered them. The tool
  // record is written RIGHT AFTER the LLM call that emitted its tool_use,
  // so the tool's timestamp is always >= its parent llm call's timestamp
  // and < the next llm call's timestamp. Walk a merged event stream sorted
  // by (timestamp, kind) — at equal timestamps, llm events sort before
  // tool events because the production audit-store insertion order is
  // "llm call first, then its tools" within a step.
  type Ev =
    | { kind: "llm"; time: string; call: (typeof sortedLlmCalls)[number] }
    | { kind: "tool"; time: string; tool: (typeof toolInvs)[number] };
  const events: Ev[] = [
    ...sortedLlmCalls.map((c) => ({ kind: "llm" as const, time: c.timestamp, call: c })),
    ...toolInvs.map((t) => ({ kind: "tool" as const, time: t.timestamp, tool: t })),
  ];
  events.sort((a, b) => {
    const dt = a.time.localeCompare(b.time);
    if (dt !== 0) return dt;
    // Same timestamp → llm before tool (production insertion order)
    return a.kind === "llm" ? -1 : 1;
  });

  const toolsByStep = new Map<number, typeof toolInvs>();
  let lastOwner: number | null = null;
  for (const ev of events) {
    if (ev.kind === "llm") {
      lastOwner = ev.call.step_index ?? -1;
    } else if (lastOwner !== null) {
      if (!toolsByStep.has(lastOwner)) toolsByStep.set(lastOwner, []);
      toolsByStep.get(lastOwner)!.push(ev.tool);
    }
  }

  const steps = sortedLlmCalls.map((call) => {
    const stepIdx = call.step_index ?? -1;
    const stepTools = (toolsByStep.get(stepIdx) ?? []).map((t) => ({
      id: t.id,
      name: t.tool_name,
      args: t.args,
      output: t.output,
      success: t.success,
      error: t.error,
      error_code: t.error_code,
      latencyMs: t.latency_ms,
      timestamp: t.timestamp,
    }));
    return {
      llmCallId: call.id,
      stepIndex: call.step_index ?? null,
      phase: call.phase ?? null,
      model: { provider: call.provider, model: call.model, alias: call.model_alias ?? null },
      tokens: { input: call.input_tokens, output: call.output_tokens },
      finishReason: call.finish_reason,
      latencyMs: call.latency_ms,
      timestamp: call.timestamp,
      promptPreview: call.prompt_messages_preview ?? [],
      responseText: call.response_text ?? null,
      responseToolCalls: call.response_tool_calls ?? [],
      toolInvocations: stepTools,
      error: call.error ?? null,
    };
  });

  // ── phase summary: one block per contiguous run of same phase ──
  const phases: Array<{
    phase: string;
    startStepIndex: number | null;
    endStepIndex: number | null;
    llmCallCount: number;
    toolInvocationCount: number;
    startedAt: string;
    endedAt: string;
  }> = [];
  for (const step of steps) {
    if (!step.phase) continue;
    const last = phases[phases.length - 1];
    if (last && last.phase === step.phase) {
      last.endStepIndex = step.stepIndex;
      last.endedAt = step.timestamp;
      last.llmCallCount += 1;
      last.toolInvocationCount += step.toolInvocations.length;
    } else {
      phases.push({
        phase: step.phase,
        startStepIndex: step.stepIndex,
        endStepIndex: step.stepIndex,
        llmCallCount: 1,
        toolInvocationCount: step.toolInvocations.length,
        startedAt: step.timestamp,
        endedAt: step.timestamp,
      });
    }
  }

  // ── code-change summary (paths_touched accumulator) ──
  const allChangedPaths = new Set<string>();
  for (const cc of codeChanges) {
    for (const p of cc.paths_touched ?? []) if (typeof p === "string") allChangedPaths.add(p);
  }

  res.json({
    success: true,
    data: {
      traceId,
      phases,
      steps,
      summary: {
        totalSteps: steps.length,
        totalLlmCalls: llmCalls.length,
        totalToolInvocations: toolInvs.length,
        totalCodeChanges: codeChanges.length,
        changedPaths: [...allChangedPaths].sort(),
        firstStepAt: steps[0]?.timestamp ?? null,
        latestStepAt: steps[steps.length - 1]?.timestamp ?? null,
        finishReason: steps[steps.length - 1]?.finishReason ?? null,
      },
    },
    requestId: res.locals.requestId,
  });
});
