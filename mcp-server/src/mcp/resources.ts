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
 *   artifacts           — final responses, code patches, etc.
 *
 * v1 will add: prompt-receipts, llm-context-log, code-changes, run-events
 * (those bind to platform records that aren't in this MCP server).
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
