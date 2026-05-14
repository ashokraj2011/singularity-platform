/**
 * M21 — query APIs (Chunk 5).
 *
 *   GET /audit/timeline?trace_id=…|capability_id=…|actor_id=…
 *   GET /audit/events/:id
 *   GET /cost/rollup?capability_id=&period=day  → daily cost + token totals
 *   GET /cost/by-model                          → top models by cost
 */
import { Router, Request, Response } from "express";
import { query } from "./db";

export const queryRouter = Router();

// ── Audit timeline ─────────────────────────────────────────────────────────

queryRouter.get("/audit/timeline", async (req: Request, res: Response) => {
  const trace = typeof req.query.trace_id === "string" ? req.query.trace_id : null;
  const cap = typeof req.query.capability_id === "string" ? req.query.capability_id : null;
  const actor = typeof req.query.actor_id === "string" ? req.query.actor_id : null;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));

  if (!trace && !cap && !actor) {
    return res.status(400).json({ error: "provide one of trace_id / capability_id / actor_id" });
  }
  const rows = await query(
    `SELECT id, trace_id, source_service, kind, subject_type, subject_id,
            actor_id, capability_id, severity, payload, created_at
     FROM audit_governance.audit_events
     WHERE ($1::text IS NULL OR trace_id      = $1)
       AND ($2::text IS NULL OR capability_id = $2)
       AND ($3::text IS NULL OR actor_id      = $3)
     ORDER BY created_at DESC
     LIMIT $4`,
    [trace, cap, actor, limit],
  );
  res.json({ count: rows.length, items: rows });
});

queryRouter.get("/audit/events/:id", async (req: Request, res: Response) => {
  const rows = await query(`SELECT * FROM audit_governance.audit_events WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: "event not found" });
  res.json(rows[0]);
});

// ── Cost rollup ─────────────────────────────────────────────────────────

queryRouter.get("/cost/rollup", async (req: Request, res: Response) => {
  const cap = typeof req.query.capability_id === "string" ? req.query.capability_id : null;
  const tenant = typeof req.query.tenant_id === "string" ? req.query.tenant_id : null;
  const period = (typeof req.query.period === "string" ? req.query.period : "day") as "hour" | "day" | "week";
  const trunc = period === "hour" ? "hour" : period === "week" ? "week" : "day";
  const limit = Math.min(120, Math.max(1, Number(req.query.limit ?? 30)));

  const rows = await query(
    `SELECT date_trunc('${trunc}', created_at) AS bucket,
            COUNT(*)::int          AS calls,
            SUM(input_tokens)::int  AS input_tokens,
            SUM(output_tokens)::int AS output_tokens,
            SUM(total_tokens)::int  AS total_tokens,
            COALESCE(SUM(cost_usd), 0)::float AS cost_usd
     FROM audit_governance.llm_calls
     WHERE ($1::text IS NULL OR capability_id = $1)
       AND ($2::text IS NULL OR tenant_id     = $2)
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT $3`,
    [cap, tenant, limit],
  );
  res.json({ period, capability_id: cap, tenant_id: tenant, count: rows.length, buckets: rows });
});

queryRouter.get("/cost/by-model", async (req: Request, res: Response) => {
  const cap = typeof req.query.capability_id === "string" ? req.query.capability_id : null;
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 7)));
  const rows = await query(
    `SELECT provider, model,
            COUNT(*)::int                         AS calls,
            SUM(total_tokens)::int                AS total_tokens,
            COALESCE(SUM(cost_usd), 0)::float     AS cost_usd
     FROM audit_governance.llm_calls
     WHERE ($1::text IS NULL OR capability_id = $1)
       AND created_at > now() - ($2 || ' days')::interval
     GROUP BY provider, model
     ORDER BY cost_usd DESC NULLS LAST`,
    [cap, days],
  );
  res.json({ days, capability_id: cap, items: rows });
});

queryRouter.get("/cost/summary", async (_req: Request, res: Response) => {
  const summary = await query(
    `SELECT
        (SELECT COUNT(*)::int FROM audit_governance.audit_events) AS audit_events,
        (SELECT COUNT(*)::int FROM audit_governance.llm_calls)    AS llm_calls,
        (SELECT COALESCE(SUM(total_tokens), 0)::int FROM audit_governance.llm_calls) AS total_tokens_all,
        (SELECT COALESCE(SUM(cost_usd), 0)::float   FROM audit_governance.llm_calls) AS cost_usd_all,
        (SELECT COUNT(*)::int FROM audit_governance.approvals WHERE status = 'pending')   AS pending_approvals,
        (SELECT COUNT(*)::int FROM audit_governance.authz_decisions WHERE decision = 'deny' AND created_at > now() - interval '1 day') AS denials_24h`,
  );
  res.json(summary[0] ?? {});
});
