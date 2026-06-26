/**
 * M65 Slice 1A — Token-savings read endpoints.
 *
 * Mirrors metrics-ledger's read surface but against the canonical
 * audit-gov Postgres `token_savings_runs` table. Operators query
 * one URL instead of two.
 *
 *   GET /api/v1/savings/session/:session_id    — runs + aggregate for one session
 *   GET /api/v1/savings/agent/:agent_id        — runs + aggregate for one agent
 *   GET /api/v1/savings/best-mode              — best-performing optimization_mode
 *   GET /api/v1/savings/dashboard              — top-line numbers for the /audit UI
 *
 * The legacy metrics-ledger endpoints (/metrics/savings/session/...) stay
 * up during the M65 transition; their backing SQLite is deprecated. The
 * context-fabric proxy will repoint to these new endpoints in Slice 1B.
 */
import { Router, Request, Response } from "express";
import { query } from "./db";
import { requireServiceAuth } from "./routes-events";

export const savingsRouter = Router();

// P0 — token-savings/cost reads. Service-token only; consumed by context-fabric +
// metrics-ledger (services) and the platform-web proxy, never browser-direct.
savingsRouter.use(requireServiceAuth);

type SavingsRow = {
  id: string;
  audit_event_id: string | null;
  session_id: string;
  agent_id: string | null;
  context_package_id: string | null;
  model_call_id: string | null;
  optimization_mode: string;
  raw_input_tokens: number;
  optimized_input_tokens: number;
  output_tokens: number;
  tokens_saved: number;
  percent_saved: number;
  estimated_raw_cost: number;
  estimated_optimized_cost: number;
  estimated_cost_saved: number;
  provider: string | null;
  model_name: string | null;
  latency_ms: number | null;
  quality_score: number | null;
  capability_id: string | null;
  tenant_id: string | null;
  created_at: Date;
};

type SavingsAggregate = {
  runs: number;
  total_raw_tokens: number;
  total_optimized_tokens: number;
  total_output_tokens: number;
  total_tokens_saved: number;
  average_savings_percent: number;
  estimated_cost_saved: number;
};

async function aggregate(filter: { col: string; val: string }): Promise<SavingsAggregate> {
  const rows = await query<SavingsAggregate>(
    `SELECT
        COUNT(*)::int                                  AS runs,
        COALESCE(SUM(raw_input_tokens), 0)::int        AS total_raw_tokens,
        COALESCE(SUM(optimized_input_tokens), 0)::int  AS total_optimized_tokens,
        COALESCE(SUM(output_tokens), 0)::int           AS total_output_tokens,
        COALESCE(SUM(tokens_saved), 0)::int            AS total_tokens_saved,
        COALESCE(AVG(percent_saved), 0)::float         AS average_savings_percent,
        COALESCE(SUM(estimated_cost_saved), 0)::float  AS estimated_cost_saved
     FROM audit_governance.token_savings_runs
     WHERE ${filter.col} = $1`,
    [filter.val],
  );
  return rows[0] ?? {
    runs: 0, total_raw_tokens: 0, total_optimized_tokens: 0, total_output_tokens: 0,
    total_tokens_saved: 0, average_savings_percent: 0, estimated_cost_saved: 0,
  };
}

savingsRouter.get("/savings/session/:session_id", async (req: Request, res: Response) => {
  const sessionId = req.params.session_id;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
  const [runs, agg] = await Promise.all([
    query<SavingsRow>(
      `SELECT * FROM audit_governance.token_savings_runs
        WHERE session_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [sessionId, limit],
    ),
    aggregate({ col: "session_id", val: sessionId }),
  ]);
  res.json({ session_id: sessionId, runs, aggregate: agg });
});

savingsRouter.get("/savings/agent/:agent_id", async (req: Request, res: Response) => {
  const agentId = req.params.agent_id;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
  const [runs, agg] = await Promise.all([
    query<SavingsRow>(
      `SELECT * FROM audit_governance.token_savings_runs
        WHERE agent_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [agentId, limit],
    ),
    aggregate({ col: "agent_id", val: agentId }),
  ]);
  res.json({ agent_id: agentId, runs, aggregate: agg });
});

savingsRouter.get("/savings/best-mode", async (_req: Request, res: Response) => {
  // Mirrors metrics-ledger's repository.best_mode(): pick the optimization
  // mode with the highest mean savings across all runs. Useful for "which
  // strategy is winning?" dashboards.
  const rows = await query<{ optimization_mode: string; avg_savings: number; cnt: number }>(
    `SELECT optimization_mode,
            AVG(percent_saved)::float AS avg_savings,
            COUNT(*)::int             AS cnt
       FROM audit_governance.token_savings_runs
      GROUP BY optimization_mode
     HAVING COUNT(*) >= 1
      ORDER BY avg_savings DESC
      LIMIT 1`,
  );
  res.json({ best_mode: rows[0]?.optimization_mode ?? null, detail: rows[0] ?? null });
});

savingsRouter.get("/savings/dashboard", async (_req: Request, res: Response) => {
  // Top-line numbers for the /audit UI's savings tile. Returns a single
  // row with the totals across the whole table — operators use the
  // session/agent endpoints for drilldown.
  const rows = await query<SavingsAggregate>(
    `SELECT
        COUNT(*)::int                                  AS runs,
        COALESCE(SUM(raw_input_tokens), 0)::int        AS total_raw_tokens,
        COALESCE(SUM(optimized_input_tokens), 0)::int  AS total_optimized_tokens,
        COALESCE(SUM(output_tokens), 0)::int           AS total_output_tokens,
        COALESCE(SUM(tokens_saved), 0)::int            AS total_tokens_saved,
        COALESCE(AVG(percent_saved), 0)::float         AS average_savings_percent,
        COALESCE(SUM(estimated_cost_saved), 0)::float  AS estimated_cost_saved
     FROM audit_governance.token_savings_runs`,
  );
  res.json(rows[0] ?? {
    runs: 0, total_raw_tokens: 0, total_optimized_tokens: 0, total_output_tokens: 0,
    total_tokens_saved: 0, average_savings_percent: 0, estimated_cost_saved: 0,
  });
});
