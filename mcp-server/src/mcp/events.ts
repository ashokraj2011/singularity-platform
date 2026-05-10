/**
 * HTTP poll fallback for the WebSocket bridge.
 *
 * Gives consumers that can't open a long-lived WS (curl, simple admin UIs,
 * cron audits) a way to drain the event ring with the same filter shape.
 *
 * GET /mcp/events?trace_id=&since_id=&limit=
 * GET /mcp/events/replay?since_id=&trace_id=  (alias of POST replay)
 */
import { Router } from "express";
import { events } from "../events/bus";
import { SubscriptionFilter } from "../events/types";

export const eventsRouter = Router();

function filterFromQuery(req: { query: Record<string, unknown> }): SubscriptionFilter {
  const f: SubscriptionFilter = {};
  const q = req.query;
  if (typeof q.trace_id === "string") f.trace_id = q.trace_id;
  if (typeof q.run_id === "string") f.run_id = q.run_id;
  if (typeof q.capability_id === "string") f.capability_id = q.capability_id;
  if (typeof q.agent_id === "string") f.agent_id = q.agent_id;
  if (typeof q.tool_invocation_id === "string") f.tool_invocation_id = q.tool_invocation_id;
  if (typeof q.artifact_id === "string") f.artifact_id = q.artifact_id;
  if (typeof q.kinds === "string") f.kinds = q.kinds.split(",") as never;
  return f;
}

eventsRouter.get("/events", (req, res) => {
  const filter = filterFromQuery(req as never);
  const limit = Number(req.query.limit ?? 200);
  const items = events.recent(filter, limit);
  res.json({ success: true, data: { items, count: items.length }, requestId: res.locals.requestId });
});

eventsRouter.get("/events/replay", (req, res) => {
  const filter = filterFromQuery(req as never);
  const since_id = typeof req.query.since_id === "string" ? req.query.since_id : undefined;
  const since_timestamp =
    typeof req.query.since_timestamp === "string" ? req.query.since_timestamp : undefined;
  const limit = Number(req.query.limit ?? 500);
  const batch = events.replaySince({ since_id, since_timestamp, filter, limit });
  res.json({
    success: true,
    data: {
      events: batch,
      count: batch.length,
      tail_id: batch.length > 0 ? batch[batch.length - 1].id : null,
    },
    requestId: res.locals.requestId,
  });
});
