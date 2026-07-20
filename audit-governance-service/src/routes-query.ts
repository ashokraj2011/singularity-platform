/**
 * M21 — query APIs (Chunk 5).
 *
 *   GET /audit/timeline?trace_id=…|capability_id=…|actor_id=…
 *   GET /audit/events/:id
 *   GET /cost/rollup?capability_id=&period=day  → daily cost + token totals
 *   GET /cost/by-model                          → top models by cost
 *
 * Every route here is tenant-scoped by `requireTenantScope` (see tenant-scope.ts).
 * Scope comes from headers, never from a query parameter, so omitting it is a
 * 400 rather than a silent widening to every tenant.
 */
import { Router, Request, Response } from "express";
import { query } from "./db";
import { requireServiceAuth } from "./routes-events";
import { requireTenantScope, scopeOf, tenantPredicate, scopeLabel } from "./tenant-scope";

export const queryRouter = Router();

// P0 — audit timeline / event-by-id / cost rollups are operator data. Service-token only;
// browser consumers reach these via the platform-web proxy (which injects the token).
// The browser-direct /audit/search + /audit/stream live in their own routers (Part 2).
queryRouter.use(requireServiceAuth);
// Authn says "you are a known service"; this says "and these are the rows you may read".
queryRouter.use(requireTenantScope);

// ── Audit timeline ─────────────────────────────────────────────────────────

queryRouter.get("/audit/timeline", async (req: Request, res: Response) => {
  const trace = typeof req.query.trace_id === "string" ? req.query.trace_id : null;
  const cap = typeof req.query.capability_id === "string" ? req.query.capability_id : null;
  const actor = typeof req.query.actor_id === "string" ? req.query.actor_id : null;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));

  if (!trace && !cap && !actor) {
    return res.status(400).json({ error: "provide one of trace_id / capability_id / actor_id" });
  }
  const scope = scopeOf(req);
  const tenant = tenantPredicate(scope, "tenant_id", 5);
  const rows = await query(
    `SELECT id, trace_id, source_service, kind, subject_type, subject_id,
            actor_id, capability_id, tenant_id, severity, payload, created_at
     FROM audit_governance.audit_events
     WHERE ($1::text IS NULL OR trace_id      = $1)
       AND ($2::text IS NULL OR capability_id = $2)
       AND ($3::text IS NULL OR actor_id      = $3)
       AND ${tenant.sql}
     ORDER BY created_at DESC
     LIMIT $4`,
    [trace, cap, actor, limit, ...tenant.params],
  );
  res.json({ count: rows.length, tenant_id: scopeLabel(scope), items: rows });
});

queryRouter.get("/audit/events/:id", async (req: Request, res: Response) => {
  const scope = scopeOf(req);
  const tenant = tenantPredicate(scope, "tenant_id", 2);
  const rows = await query(
    `SELECT * FROM audit_governance.audit_events WHERE id = $1 AND ${tenant.sql}`,
    [req.params.id, ...tenant.params],
  );
  // Deliberately 404, not 403: an out-of-scope event is indistinguishable from a
  // missing one, so this endpoint cannot be used to probe for another tenant's ids.
  if (rows.length === 0) return res.status(404).json({ error: "event not found" });
  res.json(rows[0]);
});

// ── Cost rollup ─────────────────────────────────────────────────────────

queryRouter.get("/cost/rollup", async (req: Request, res: Response) => {
  const cap = typeof req.query.capability_id === "string" ? req.query.capability_id : null;
  const period = (typeof req.query.period === "string" ? req.query.period : "day") as "hour" | "day" | "week";
  const trunc = period === "hour" ? "hour" : period === "week" ? "week" : "day";
  const limit = Math.min(120, Math.max(1, Number(req.query.limit ?? 30)));

  const scope = scopeOf(req);
  const tenant = tenantPredicate(scope, "tenant_id", 3);
  const rows = await query(
    `SELECT date_trunc('${trunc}', created_at) AS bucket,
            COUNT(*)::int          AS calls,
            SUM(input_tokens)::int  AS input_tokens,
            SUM(output_tokens)::int AS output_tokens,
            SUM(total_tokens)::int  AS total_tokens,
            COALESCE(SUM(cost_usd), 0)::float AS cost_usd
     FROM audit_governance.llm_calls
     WHERE ($1::text IS NULL OR capability_id = $1)
       AND ${tenant.sql}
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT $2`,
    [cap, limit, ...tenant.params],
  );
  res.json({ period, capability_id: cap, tenant_id: scopeLabel(scope), count: rows.length, buckets: rows });
});

queryRouter.get("/cost/by-model", async (req: Request, res: Response) => {
  const cap = typeof req.query.capability_id === "string" ? req.query.capability_id : null;
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 7)));
  const scope = scopeOf(req);
  const tenant = tenantPredicate(scope, "tenant_id", 3);
  const rows = await query(
    `SELECT provider, model,
            COUNT(*)::int                         AS calls,
            SUM(total_tokens)::int                AS total_tokens,
            COALESCE(SUM(cost_usd), 0)::float     AS cost_usd
     FROM audit_governance.llm_calls
     WHERE ($1::text IS NULL OR capability_id = $1)
       AND created_at > now() - ($2 || ' days')::interval
       AND ${tenant.sql}
     GROUP BY provider, model
     ORDER BY cost_usd DESC NULLS LAST`,
    [cap, days, ...tenant.params],
  );
  res.json({ days, capability_id: cap, tenant_id: scopeLabel(scope), items: rows });
});

queryRouter.get("/cost/summary", async (req: Request, res: Response) => {
  const scope = scopeOf(req);
  // Every subselect takes the same predicate against $1, so one param serves all
  // of them. `authz_decisions` carries no tenant column of its own and is scoped
  // through the audit_event it references; rows with no linked event are out of
  // scope for a tenant read and appear only under cross-tenant scope.
  const tenant = tenantPredicate(scope, "tenant_id", 1);
  const authzTenant = scope.mode === "all"
    ? "TRUE"
    : `EXISTS (SELECT 1 FROM audit_governance.audit_events e
                WHERE e.id = d.audit_event_id AND e.tenant_id = $1)`;
  const summary = await query(
    `SELECT
        (SELECT COUNT(*)::int FROM audit_governance.audit_events WHERE ${tenant.sql}) AS audit_events,
        (SELECT COUNT(*)::int FROM audit_governance.llm_calls    WHERE ${tenant.sql}) AS llm_calls,
        (SELECT COALESCE(SUM(total_tokens), 0)::int FROM audit_governance.llm_calls WHERE ${tenant.sql}) AS total_tokens_all,
        (SELECT COALESCE(SUM(cost_usd), 0)::float   FROM audit_governance.llm_calls WHERE ${tenant.sql}) AS cost_usd_all,
        (SELECT COUNT(*)::int FROM audit_governance.approvals
          WHERE status = 'pending' AND ${tenant.sql})   AS pending_approvals,
        (SELECT COUNT(*)::int FROM audit_governance.authz_decisions d
          WHERE d.decision = 'deny' AND d.created_at > now() - interval '1 day'
            AND ${authzTenant}) AS denials_24h`,
    tenant.params,
  );
  res.json({ tenant_id: scopeLabel(scope), ...(summary[0] ?? {}) });
});
