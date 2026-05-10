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

resourcesRouter.get("/resources/llm-calls", (_req, res) => {
  res.json({ success: true, data: { items: audit.llmCalls.recent(50) }, requestId: res.locals.requestId });
});
resourcesRouter.get("/resources/llm-calls/:id", (req, res) => {
  const r = audit.llmCalls.byId(req.params.id);
  if (!r) throw new NotFoundError(`llm_call ${req.params.id} not found`);
  res.json({ success: true, data: r, requestId: res.locals.requestId });
});

resourcesRouter.get("/resources/tool-invocations", (_req, res) => {
  res.json({
    success: true,
    data: { items: audit.toolInvocations.recent(50) },
    requestId: res.locals.requestId,
  });
});
resourcesRouter.get("/resources/tool-invocations/:id", (req, res) => {
  const r = audit.toolInvocations.byId(req.params.id);
  if (!r) throw new NotFoundError(`tool_invocation ${req.params.id} not found`);
  res.json({ success: true, data: r, requestId: res.locals.requestId });
});

resourcesRouter.get("/resources/artifacts", (_req, res) => {
  res.json({
    success: true,
    data: { items: audit.artifacts.recent(50) },
    requestId: res.locals.requestId,
  });
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
