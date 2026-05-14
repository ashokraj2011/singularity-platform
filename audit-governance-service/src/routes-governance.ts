/**
 * M21 — governance APIs (Chunk 4).
 *
 *   approvals      — POST /, GET /:id, POST /:id/decide, GET / (list)
 *   budgets        — POST /, GET /, GET /check?scope_type&scope_id&tokens_estimated
 *   rate-limits    — POST /, GET /, GET /check?scope_type&scope_id
 *   authz          — POST /authz/decisions (sync writer for IAM/workgraph),
 *                    GET  /authz/decisions?actor_id=…
 */
import { Router, Request, Response } from "express";
import { query, queryOne } from "./db";
import {
  approvalCreateSchema, approvalDecideSchema,
  budgetUpsertSchema, rateLimitUpsertSchema, authzDecisionSchema,
} from "./types";

export const governanceRouter = Router();

// ── Approvals ──────────────────────────────────────────────────────────────

governanceRouter.post("/approvals", async (req: Request, res: Response) => {
  const p = approvalCreateSchema.parse(req.body);
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO audit_governance.approvals
       (id, trace_id, capability_id, tenant_id, source_service,
        tool_name, tool_args, risk_level, requested_by, expires_at,
        continuation_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [p.id, p.trace_id ?? null, p.capability_id ?? null, p.tenant_id ?? null,
    p.source_service, p.tool_name, JSON.stringify(p.tool_args), p.risk_level ?? null,
    p.requested_by ?? null, p.expires_at ?? null,
    p.continuation_payload ? JSON.stringify(p.continuation_payload) : null],
  );
  res.status(201).json(row ?? { id: p.id, status: "exists" });
});

// M21.5 — atomic single-use claim. mcp-server's takePending() now hits this
// instead of the in-memory map. Status transitions:
//   pending  → 409 (caller must /decide first)
//   approved → 200 with continuation_payload + decision='approved'; row → 'consumed'
//   rejected → 200 with continuation_payload + decision='rejected'; row → 'consumed'
//   consumed → 409 (single-use; already claimed)
//   expired  → 410
//
// Implementation: a CTE captures the row's pre-update status (=decision) and
// the UPDATE flips it to 'consumed' atomically — no race window where two
// callers could both succeed.
governanceRouter.post("/approvals/:id/consume", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const row = await queryOne<{
    id: string; decision: "approved" | "rejected";
    decided_by: string | null; decision_reason: string | null;
    continuation_payload: unknown; expires_at: string | null;
  }>(
    `WITH claim AS (
       UPDATE audit_governance.approvals AS a
       SET status = 'consumed', consumed_at = now()
       FROM audit_governance.approvals AS pre
       WHERE a.id = $1
         AND pre.id = $1
         AND pre.status IN ('approved', 'rejected')
         AND (pre.expires_at IS NULL OR pre.expires_at > now())
       RETURNING a.id, pre.status AS decision, a.decided_by, a.decision_reason,
                a.continuation_payload, a.expires_at
     )
     SELECT * FROM claim`,
    [id],
  );
  if (!row) {
    const cur = await queryOne<{ status: string; expires_at: string | null }>(
      `SELECT status, expires_at FROM audit_governance.approvals WHERE id = $1`, [id],
    );
    if (!cur) return res.status(404).json({ error: "approval not found" });
    if (cur.expires_at && new Date(cur.expires_at as unknown as string) <= new Date()) {
      return res.status(410).json({ error: "approval expired" });
    }
    return res.status(409).json({
      error: `approval is ${cur.status} (need approved or rejected; single-use)`,
    });
  }
  res.json({
    id: row.id,
    decision: row.decision,
    decided_by: row.decided_by,
    decision_reason: row.decision_reason,
    continuation_payload: row.continuation_payload,
  });
});

governanceRouter.get("/approvals/:id", async (req: Request, res: Response) => {
  const row = await queryOne(
    `SELECT * FROM audit_governance.approvals WHERE id = $1`, [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "approval not found" });
  res.json(row);
});

governanceRouter.get("/approvals", async (req: Request, res: Response) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const cap = typeof req.query.capability_id === "string" ? req.query.capability_id : null;
  const rows = await query(
    `SELECT * FROM audit_governance.approvals
     WHERE ($1::text IS NULL OR status = $1)
       AND ($2::text IS NULL OR capability_id = $2)
     ORDER BY requested_at DESC LIMIT 200`,
    [status, cap],
  );
  res.json({ items: rows });
});

governanceRouter.post("/approvals/:id/decide", async (req: Request, res: Response) => {
  const d = approvalDecideSchema.parse(req.body);
  const row = await queryOne(
    `UPDATE audit_governance.approvals
     SET status = $1, decided_by = $2, decision_reason = $3, decided_at = now()
     WHERE id = $4 AND status = 'pending'
     RETURNING *`,
    [d.decision, d.decided_by ?? null, d.decision_reason ?? null, req.params.id],
  );
  if (!row) return res.status(409).json({ error: "approval not found or no longer pending" });
  res.json(row);
});

// ── Budgets ────────────────────────────────────────────────────────────────

function periodWindow(period: "day" | "week" | "month"): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (period === "week") {
    const dayOfWeek = start.getUTCDay();
    start.setUTCDate(start.getUTCDate() - dayOfWeek);
  } else if (period === "month") {
    start.setUTCDate(1);
  }
  const end = new Date(start);
  if (period === "day") end.setUTCDate(end.getUTCDate() + 1);
  if (period === "week") end.setUTCDate(end.getUTCDate() + 7);
  if (period === "month") end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}

governanceRouter.post("/budgets", async (req: Request, res: Response) => {
  const p = budgetUpsertSchema.parse(req.body);
  const { start, end } = periodWindow(p.period);
  const row = await queryOne(
    `INSERT INTO audit_governance.budgets
       (scope_type, scope_id, period, tokens_max, cost_max_usd, period_start, period_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (scope_type, scope_id, period, period_start)
     DO UPDATE SET tokens_max = EXCLUDED.tokens_max,
                   cost_max_usd = EXCLUDED.cost_max_usd,
                   updated_at = now()
     RETURNING *`,
    [p.scope_type, p.scope_id, p.period, p.tokens_max ?? null, p.cost_max_usd ?? null, start, end],
  );
  res.status(201).json(row);
});

governanceRouter.get("/budgets", async (req: Request, res: Response) => {
  const sType = typeof req.query.scope_type === "string" ? req.query.scope_type : null;
  const sId = typeof req.query.scope_id === "string" ? req.query.scope_id : null;
  const rows = await query(
    `SELECT * FROM audit_governance.budgets
     WHERE ($1::text IS NULL OR scope_type = $1)
       AND ($2::text IS NULL OR scope_id = $2)
       AND now() < period_end
     ORDER BY period_start DESC LIMIT 200`,
    [sType, sId],
  );
  res.json({ items: rows });
});

// Pre-call check — returns {allowed:bool, remaining_tokens, remaining_cost}.
// Producers should call before billing; rejection means "skip the LLM call".
governanceRouter.get("/budgets/check", async (req: Request, res: Response) => {
  const sType = String(req.query.scope_type ?? "");
  const sId = String(req.query.scope_id ?? "");
  const tokens = Number(req.query.tokens_estimated ?? 0);
  if (!sType || !sId) return res.status(400).json({ error: "scope_type + scope_id required" });

  const rows = await query<Record<string, string | number | null>>(
    `SELECT period, tokens_max, cost_max_usd, current_tokens, current_cost
     FROM audit_governance.budgets
     WHERE scope_type = $1 AND scope_id = $2
       AND now() >= period_start AND now() < period_end`,
    [sType, sId],
  );
  if (rows.length === 0) {
    return res.json({ allowed: true, reason: "no budget configured", budgets: [] });
  }

  let allowed = true;
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const tokensMax = r.tokens_max == null ? null : Number(r.tokens_max);
    const costMax = r.cost_max_usd == null ? null : Number(r.cost_max_usd);
    const currentTokens = Number(r.current_tokens);
    const currentCost = Number(r.current_cost);
    const remTokens = tokensMax == null ? null : tokensMax - currentTokens;
    const remCost = costMax == null ? null : costMax - currentCost;
    const fits = (tokensMax == null || currentTokens + tokens <= tokensMax)
      && (costMax == null || currentCost <= costMax);
    if (!fits) allowed = false;
    out.push({
      period: r.period, tokens_max: tokensMax, cost_max_usd: costMax,
      current_tokens: currentTokens, current_cost: currentCost,
      remaining_tokens: remTokens, remaining_cost: remCost,
      fits,
    });
  }
  res.json({ allowed, budgets: out });
});

// ── Rate limits ────────────────────────────────────────────────────────────

governanceRouter.post("/rate-limits", async (req: Request, res: Response) => {
  const p = rateLimitUpsertSchema.parse(req.body);
  const row = await queryOne(
    `INSERT INTO audit_governance.rate_limits (scope_type, scope_id, period_seconds, max_calls)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (scope_type, scope_id, period_seconds)
     DO UPDATE SET max_calls = EXCLUDED.max_calls
     RETURNING *`,
    [p.scope_type, p.scope_id, p.period_seconds, p.max_calls],
  );
  res.status(201).json(row);
});

governanceRouter.get("/rate-limits", async (_req: Request, res: Response) => {
  const rows = await query(`SELECT * FROM audit_governance.rate_limits ORDER BY scope_type, scope_id LIMIT 200`);
  res.json({ items: rows });
});

// Sliding-window-ish check + bump. Rolls window on each call.
governanceRouter.get("/rate-limits/check", async (req: Request, res: Response) => {
  const sType = String(req.query.scope_type ?? "");
  const sId = String(req.query.scope_id ?? "");
  if (!sType || !sId) return res.status(400).json({ error: "scope_type + scope_id required" });
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM audit_governance.rate_limits WHERE scope_type=$1 AND scope_id=$2`,
    [sType, sId],
  );
  if (rows.length === 0) return res.json({ allowed: true, reason: "no rate limit configured" });

  let allowed = true;
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const id = String(r.id);
    const periodSec = Number(r.period_seconds);
    const maxCalls = Number(r.max_calls);
    const updated = await queryOne<Record<string, unknown>>(
      `UPDATE audit_governance.rate_limits
       SET window_start = CASE
             WHEN now() - window_start > ($1 || ' seconds')::interval THEN now()
             ELSE window_start END,
           current_calls = CASE
             WHEN now() - window_start > ($1 || ' seconds')::interval THEN 1
             ELSE current_calls + 1 END
       WHERE id = $2
       RETURNING current_calls, max_calls, window_start`,
      [periodSec, id],
    );
    const cur = Number(updated?.current_calls ?? 0);
    const fits = cur <= maxCalls;
    if (!fits) allowed = false;
    out.push({ period_seconds: periodSec, max_calls: maxCalls, current_calls: cur, fits });
  }
  res.json({ allowed, rate_limits: out });
});

// ── Authz decisions (sync writer + listing) ────────────────────────────────

governanceRouter.post("/authz/decisions", async (req: Request, res: Response) => {
  const p = authzDecisionSchema.parse(req.body);
  const evt = await queryOne<{ id: string }>(
    `INSERT INTO audit_governance.audit_events
       (trace_id, source_service, kind, subject_type, subject_id, actor_id, severity, payload)
     VALUES ($1,$2,'authz.decision',$3,$4,$5,$6,$7::jsonb)
     RETURNING id`,
    [p.trace_id ?? null, p.decided_by ?? "iam", p.resource_type, p.resource_id ?? null,
    p.actor_id, p.decision === "deny" ? "warn" : "audit", JSON.stringify(p)],
  );
  await query(
    `INSERT INTO audit_governance.authz_decisions
       (audit_event_id, trace_id, actor_id, resource_type, resource_id, action, decision, reason, decided_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [evt!.id, p.trace_id ?? null, p.actor_id, p.resource_type, p.resource_id ?? null,
    p.action, p.decision, p.reason ?? null, p.decided_by ?? null],
  );
  res.status(201).json({ id: evt!.id });
});

governanceRouter.get("/authz/decisions", async (req: Request, res: Response) => {
  const actor = typeof req.query.actor_id === "string" ? req.query.actor_id : null;
  const resource = typeof req.query.resource_id === "string" ? req.query.resource_id : null;
  const decision = typeof req.query.decision === "string" ? req.query.decision : null;
  const rows = await query(
    `SELECT * FROM audit_governance.authz_decisions
     WHERE ($1::text IS NULL OR actor_id    = $1)
       AND ($2::text IS NULL OR resource_id = $2)
       AND ($3::text IS NULL OR decision    = $3)
     ORDER BY created_at DESC LIMIT 200`,
    [actor, resource, decision],
  );
  res.json({ items: rows });
});
