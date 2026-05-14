/**
 * Singularity Engine — REST API routes.
 *
 * Mounted at /api/v1/engine in the audit-governance-service.
 *
 *   GET    /issues                    — list issues (filterable)
 *   GET    /issues/:id                — issue detail
 *   POST   /issues/:id/diagnose       — trigger LLM root-cause analysis
 *   POST   /issues/:id/resolve        — resolve + optionally create evaluator & dataset
 *   POST   /issues/:id/dismiss        — dismiss issue
 *   POST   /sweep                     — manually trigger a sweep
 *   GET    /evaluators                — list evaluators
 *   GET    /evaluators/:id            — evaluator detail
 *   PATCH  /evaluators/:id            — toggle enabled / update config
 *   POST   /evaluators/run            — run evaluators against recent traces
 *   GET    /datasets                  — list datasets
 *   POST   /datasets                  — create dataset
 *   GET    /datasets/:id/examples     — list examples
 *   POST   /datasets/:id/examples     — add examples
 *   POST   /datasets/from-issue/:id   — auto-build dataset from an issue
 *   GET    /stats                     — dashboard stats
 */
import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { diagnoseIssue } from "./diagnose";
import { createEvaluatorFromIssue, runEvaluatorsForRecentTraces } from "./evaluator-factory";
import { createDataset, addExamples, buildDatasetFromIssue } from "./dataset-builder";
import { runSweep } from "./sweep";

export const engineRouter = Router();

// ── Issues ─────────────────────────────────────────────────────────────

engineRouter.get("/issues", async (req: Request, res: Response) => {
  const status  = typeof req.query.status      === "string" ? req.query.status      : null;
  const sev     = typeof req.query.severity    === "string" ? req.query.severity    : null;
  const cap     = typeof req.query.capability_id === "string" ? req.query.capability_id : null;
  const cat     = typeof req.query.category    === "string" ? req.query.category    : null;
  const limit   = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));

  const rows = await query(
    `SELECT id, title, severity, status, category, capability_id,
            trace_count, affected_pct, first_seen_at, last_seen_at,
            error_pattern, created_at, updated_at
     FROM audit_governance.engine_issues
     WHERE ($1::text IS NULL OR status        = $1)
       AND ($2::text IS NULL OR severity      = $2)
       AND ($3::text IS NULL OR capability_id = $3)
       AND ($4::text IS NULL OR category      = $4)
     ORDER BY
       CASE severity
         WHEN 'critical' THEN 0
         WHEN 'high'     THEN 1
         WHEN 'medium'   THEN 2
         WHEN 'low'      THEN 3
         ELSE 4
       END,
       trace_count DESC,
       last_seen_at DESC
     LIMIT $5`,
    [status, sev, cap, cat, limit],
  );
  res.json({ count: rows.length, items: rows });
});

engineRouter.get("/issues/:id", async (req: Request, res: Response) => {
  const row = await queryOne(
    `SELECT * FROM audit_governance.engine_issues WHERE id = $1`,
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "issue not found" });
  res.json(row);
});

engineRouter.post("/issues/:id/diagnose", async (req: Request, res: Response) => {
  try {
    const result = await diagnoseIssue(req.params.id);
    res.json(result);
  } catch (err) {
    const e = err as { status?: number; message: string };
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

engineRouter.post("/issues/:id/resolve", async (req: Request, res: Response) => {
  const { resolved_by, resolution_notes, create_evaluator, create_dataset } = req.body ?? {};

  const row = await queryOne(
    `UPDATE audit_governance.engine_issues
     SET status          = 'resolved',
         resolved_at     = now(),
         resolved_by     = $1,
         resolution_notes = $2,
         updated_at      = now()
     WHERE id = $3 AND status != 'resolved'
     RETURNING id, title, status`,
    [resolved_by ?? null, resolution_notes ?? null, req.params.id],
  );
  if (!row) return res.status(409).json({ error: "issue not found or already resolved" });

  const result: Record<string, unknown> = { issue: row };

  // Optionally create an evaluator.
  if (create_evaluator !== false) {
    try {
      const ev = await createEvaluatorFromIssue(req.params.id);
      result.evaluator = ev;
    } catch (err) {
      result.evaluator_error = (err as Error).message;
    }
  }

  // Optionally build a dataset.
  if (create_dataset !== false) {
    try {
      const ds = await buildDatasetFromIssue(req.params.id);
      result.dataset = ds;
    } catch (err) {
      result.dataset_error = (err as Error).message;
    }
  }

  res.json(result);
});

engineRouter.post("/issues/:id/dismiss", async (req: Request, res: Response) => {
  const { dismissed_by, reason } = req.body ?? {};
  const row = await queryOne(
    `UPDATE audit_governance.engine_issues
     SET status          = 'dismissed',
         resolved_by     = $1,
         resolution_notes = $2,
         resolved_at     = now(),
         updated_at      = now()
     WHERE id = $3
     RETURNING id, title, status`,
    [dismissed_by ?? null, reason ?? null, req.params.id],
  );
  if (!row) return res.status(404).json({ error: "issue not found" });
  res.json(row);
});

// ── Manual sweep trigger ──────────────────────────────────────────────

engineRouter.post("/sweep", async (_req: Request, res: Response) => {
  await runSweep();
  res.json({ status: "sweep completed" });
});

// ── Evaluators ────────────────────────────────────────────────────────

engineRouter.get("/evaluators", async (req: Request, res: Response) => {
  const enabled = typeof req.query.enabled === "string"
    ? req.query.enabled === "true"
    : null;
  const rows = await query(
    `SELECT * FROM audit_governance.engine_evaluators
     WHERE ($1::boolean IS NULL OR enabled = $1)
     ORDER BY created_at DESC
     LIMIT 200`,
    [enabled],
  );
  res.json({ count: rows.length, items: rows });
});

engineRouter.get("/evaluators/:id", async (req: Request, res: Response) => {
  const row = await queryOne(
    `SELECT * FROM audit_governance.engine_evaluators WHERE id = $1`,
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "evaluator not found" });
  res.json(row);
});

engineRouter.patch("/evaluators/:id", async (req: Request, res: Response) => {
  const { enabled, evaluator_config } = req.body ?? {};
  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (typeof enabled === "boolean") {
    updates.push(`enabled = $${idx++}`);
    params.push(enabled);
  }
  if (evaluator_config && typeof evaluator_config === "object") {
    updates.push(`evaluator_config = $${idx++}::jsonb`);
    params.push(JSON.stringify(evaluator_config));
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }

  params.push(req.params.id);
  const row = await queryOne(
    `UPDATE audit_governance.engine_evaluators
     SET ${updates.join(", ")}
     WHERE id = $${idx}
     RETURNING *`,
    params,
  );
  if (!row) return res.status(404).json({ error: "evaluator not found" });
  res.json(row);
});

engineRouter.post("/evaluators/run", async (req: Request, res: Response) => {
  const windowMinutes = Number(req.body?.window_minutes ?? 60);
  const limit = Math.min(Number(req.body?.limit ?? 100), 500);
  const result = await runEvaluatorsForRecentTraces(windowMinutes, limit);
  res.json(result);
});

// ── Datasets ──────────────────────────────────────────────────────────

engineRouter.get("/datasets", async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT * FROM audit_governance.engine_datasets
     ORDER BY created_at DESC LIMIT 200`,
  );
  res.json({ count: rows.length, items: rows });
});

engineRouter.post("/datasets", async (req: Request, res: Response) => {
  const { name, description, issue_id, capability_id } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const ds = await createDataset({ name, description, issue_id, capability_id });
  res.status(201).json(ds);
});

engineRouter.get("/datasets/:id/examples", async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const rows = await query(
    `SELECT * FROM audit_governance.engine_dataset_examples
     WHERE dataset_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [req.params.id, limit],
  );
  res.json({ count: rows.length, items: rows });
});

engineRouter.post("/datasets/:id/examples", async (req: Request, res: Response) => {
  const examples = Array.isArray(req.body?.examples) ? req.body.examples : [];
  if (examples.length === 0) return res.status(400).json({ error: "examples[] required" });
  const result = await addExamples(req.params.id, examples);
  res.status(201).json(result);
});

engineRouter.post("/datasets/from-issue/:id", async (req: Request, res: Response) => {
  try {
    const result = await buildDatasetFromIssue(req.params.id);
    res.status(201).json(result);
  } catch (err) {
    const e = err as { status?: number; message: string };
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────

engineRouter.get("/stats", async (_req: Request, res: Response) => {
  const stats = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM audit_governance.engine_issues WHERE status = 'open')        AS open_issues,
       (SELECT COUNT(*)::int FROM audit_governance.engine_issues WHERE status = 'fix_proposed') AS fix_proposed,
       (SELECT COUNT(*)::int FROM audit_governance.engine_issues WHERE status = 'resolved')    AS resolved_issues,
       (SELECT COUNT(*)::int FROM audit_governance.engine_issues WHERE status = 'dismissed')   AS dismissed_issues,
       (SELECT COUNT(*)::int FROM audit_governance.engine_issues WHERE severity = 'critical' AND status = 'open') AS critical_open,
       (SELECT COUNT(*)::int FROM audit_governance.engine_issues WHERE severity = 'high' AND status = 'open')     AS high_open,
       (SELECT COUNT(*)::int FROM audit_governance.engine_evaluators WHERE enabled = true)      AS active_evaluators,
       (SELECT COALESCE(SUM(fire_count), 0)::int FROM audit_governance.engine_evaluators)       AS total_eval_runs,
       (SELECT COALESCE(SUM(fail_count), 0)::int FROM audit_governance.engine_evaluators)       AS total_eval_failures,
       (SELECT COUNT(*)::int FROM audit_governance.engine_datasets)                             AS datasets,
       (SELECT COALESCE(SUM(example_count), 0)::int FROM audit_governance.engine_datasets)      AS dataset_examples,
       (SELECT COUNT(*)::int FROM audit_governance.engine_issues
        WHERE status = 'resolved' AND resolved_at > now() - interval '7 days')                 AS resolved_this_week`,
  );
  res.json(stats[0] ?? {});
});
