import { Router, Request, Response } from "express";
import { query, queryOne } from "../database";
import { optionalAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";

export const runnerRoutes = Router();
runnerRoutes.use(optionalAuth);

// POST /api/v1/client-runners/register
runnerRoutes.post("/client-runners/register", async (req: Request, res: Response) => {
  const { runner_id, runner_name, runner_type, runner_version, user_id, capabilities } = req.body;
  if (!runner_id) throw new AppError("runner_id is required");

  const [runner] = await query(
    `INSERT INTO tool.client_runners (id, user_id, runner_name, runner_type, runner_version, capabilities, status, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,'online',now())
     ON CONFLICT (id) DO UPDATE SET
       runner_name=EXCLUDED.runner_name, runner_type=EXCLUDED.runner_type,
       runner_version=EXCLUDED.runner_version, capabilities=EXCLUDED.capabilities,
       status='online', last_seen_at=now()
     RETURNING *`,
    [runner_id, user_id ?? null, runner_name ?? null, runner_type ?? null, runner_version ?? null, JSON.stringify(capabilities ?? {})]
  );

  res.status(201).json(runner);
});

// POST /api/v1/client-runners/:id/heartbeat
runnerRoutes.post("/client-runners/:id/heartbeat", async (_req: Request, res: Response) => {
  const runner = await queryOne(
    "UPDATE tool.client_runners SET last_seen_at=now(), status='online' WHERE id=$1 RETURNING id, status, last_seen_at",
    [_req.params.id]
  );
  if (!runner) throw new AppError("Runner not found", 404);
  res.json(runner);
});

// GET /api/v1/client-runners/:id/jobs
runnerRoutes.get("/client-runners/:id/jobs", async (req: Request, res: Response) => {
  const jobs = await query(
    `SELECT j.id as job_id, j.tool_execution_id, j.job_payload, j.created_at,
            e.tool_name, e.arguments_json as arguments
     FROM tool.client_execution_jobs j
     JOIN tool.tool_executions e ON e.id = j.tool_execution_id
     WHERE j.assigned_runner_id=$1 AND j.status='pending'
     ORDER BY j.created_at ASC LIMIT 10`,
    [req.params.id]
  );

  // If no assigned runner, return unassigned pending jobs and assign them
  if (jobs.length === 0) {
    const unassigned = await query(
      `SELECT j.id as job_id, j.tool_execution_id, j.job_payload, j.created_at,
              e.tool_name, e.arguments_json as arguments
       FROM tool.client_execution_jobs j
       JOIN tool.tool_executions e ON e.id = j.tool_execution_id
       WHERE j.assigned_runner_id IS NULL AND j.status='pending'
       ORDER BY j.created_at ASC LIMIT 5`
    );

    if (unassigned.length > 0) {
      const ids = unassigned.map((j) => (j as Record<string, unknown>).job_id);
      await query(
        `UPDATE tool.client_execution_jobs SET assigned_runner_id=$1 WHERE id = ANY($2::uuid[])`,
        [req.params.id, ids]
      );
    }

    res.json({ jobs: unassigned });
    return;
  }

  res.json({ jobs });
});

// POST /api/v1/client-execution-jobs/:id/complete
runnerRoutes.post("/client-execution-jobs/:id/complete", async (req: Request, res: Response) => {
  const { status, output_summary, output, receipt } = req.body;

  const [job] = await query(
    `UPDATE tool.client_execution_jobs
     SET status=$1, result_payload=$2, completed_at=now()
     WHERE id=$3 RETURNING *`,
    [status, JSON.stringify({ output, receipt }), req.params.id]
  );
  if (!job) throw new AppError("Job not found", 404);

  const j = job as Record<string, unknown>;
  await query(
    `UPDATE tool.tool_executions
     SET status=$1, output_json=$2, output_summary=$3, completed_at=now()
     WHERE id=$4`,
    [status, JSON.stringify(output ?? {}), output_summary ?? null, j.tool_execution_id]
  );

  res.json({ message: "Job completed", job });
});

// POST /api/v1/client-execution-jobs/:id/fail
runnerRoutes.post("/client-execution-jobs/:id/fail", async (req: Request, res: Response) => {
  const { error } = req.body;

  const [job] = await query(
    `UPDATE tool.client_execution_jobs SET status='error', error=$1, completed_at=now() WHERE id=$2 RETURNING *`,
    [error ?? "Unknown error", req.params.id]
  );
  if (!job) throw new AppError("Job not found", 404);

  const j = job as Record<string, unknown>;
  await query(
    "UPDATE tool.tool_executions SET status='error', error=$1, completed_at=now() WHERE id=$2",
    [error, j.tool_execution_id]
  );

  res.json({ message: "Job failed", job });
});

// GET /api/v1/client-runners
runnerRoutes.get("/client-runners", async (_req: Request, res: Response) => {
  const runners = await query("SELECT * FROM tool.client_runners ORDER BY last_seen_at DESC NULLS LAST");
  res.json({ runners });
});
