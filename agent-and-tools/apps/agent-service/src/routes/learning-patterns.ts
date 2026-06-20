/**
 * M67 Slice 1A — Routes folded in from the standalone learning-service
 * (agent-and-tools/apps/learning-service). The standalone service was 233 LOC
 * of Express on the same `at-postgres` instance — folding eliminates one
 * container without changing the wire contract.
 *
 * Paths kept identical so prompt-composer + mcp-server only need to flip
 * LEARNING_SERVICE_URL from http://learning-service:3006 → http://agent-service:3001.
 * The `learning.*` schema now lives in the `singularity` DB (was its own
 * `singularity_learning` DB) — see ensureLearningSchema() below.
 */
import { timingSafeEqual } from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import { z, ZodError } from "zod";
import { query, pool } from "../database";

const SERVICE_TOKEN = process.env.LEARNING_SERVICE_TOKEN ?? process.env.AUDIT_GOV_SERVICE_TOKEN ?? "";

// Local service-token gate (matches the standalone learning-service's
// posture so mcp-server / prompt-composer can keep their existing tokens).
function tokenMatches(candidate: string): boolean {
  if (!SERVICE_TOKEN || !candidate) return false;
  const expected = Buffer.from(SERVICE_TOKEN);
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireServiceAuth(req: Request, res: Response, next: NextFunction): void {
  if (!SERVICE_TOKEN) {
    res.status(503).json({ error: "learning service token not configured" });
    return;
  }
  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7)
    : String(req.headers["x-service-token"] ?? "");
  if (tokenMatches(token)) {
    next();
    return;
  }
  res.status(401).json({ error: "invalid service token" });
}

export const learningPatternsRoutes = Router();

learningPatternsRoutes.use(requireServiceAuth);

learningPatternsRoutes.get("/failures/:capabilityId/summary", async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT * FROM learning.capability_failure_summary
      WHERE capability_id = $1
      ORDER BY refreshed_at DESC
      LIMIT 1`,
    [req.params.capabilityId],
  );
  res.json({ summary: rows[0] ?? null });
});

learningPatternsRoutes.get("/patterns", async (req: Request, res: Response) => {
  const capabilityType = typeof req.query.capability_type === "string" ? req.query.capability_type : null;
  const capabilityId = typeof req.query.capability_id === "string" ? req.query.capability_id : null;
  const patternKind = typeof req.query.kind === "string" ? req.query.kind : null;
  const minSuccessRate = Number(req.query.min_success_rate ?? 0);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 10) || 10, 1), 50);
  const rows = await query(
    `SELECT * FROM learning.capability_type_pattern
      WHERE ($1::text IS NULL OR capability_type = $1)
        AND ($2::text IS NULL OR capability_id = $2)
        AND ($3::text IS NULL OR pattern_kind = $3)
        AND ($4::numeric IS NULL OR success_rate IS NULL OR success_rate >= $4)
      ORDER BY updated_at DESC
      LIMIT $5`,
    [capabilityType, capabilityId, patternKind, Number.isFinite(minSuccessRate) ? minSuccessRate : null, limit],
  );
  res.json({ items: rows });
});

const patternSchema = z.object({
  capabilityId: z.string().optional(),
  capabilityType: z.string().optional(),
  patternKind: z.string().default("outcome"),
  summary: z.string().min(1),
  evidence: z.record(z.string(), z.unknown()).default({}),
  successRate: z.number().min(0).max(1).optional(),
});

learningPatternsRoutes.post("/patterns", async (req: Request, res: Response) => {
  try {
    const input = patternSchema.parse(req.body ?? {});
    const rows = await query<{ id: string }>(
      `INSERT INTO learning.capability_type_pattern
         (capability_id, capability_type, pattern_kind, summary, evidence, success_rate)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       RETURNING id`,
      [
        input.capabilityId ?? null,
        input.capabilityType ?? null,
        input.patternKind,
        input.summary,
        JSON.stringify(input.evidence ?? {}),
        input.successRate ?? null,
      ],
    );
    res.status(201).json({ id: rows[0].id, status: "recorded" });
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "validation", details: err.flatten() });
      return;
    }
    throw err;
  }
});

const refreshSchema = z.object({
  capabilityId: z.string(),
  capabilityType: z.string().optional(),
  summary: z.string().min(1),
  evidence: z.record(z.string(), z.unknown()).default({}),
  lastFailureAt: z.string().optional(),
});

learningPatternsRoutes.post("/summarize/refresh", async (req: Request, res: Response) => {
  try {
    const input = refreshSchema.parse(req.body ?? {});
    const rows = await query<{ id: string }>(
      `INSERT INTO learning.capability_failure_summary
         (capability_id, capability_type, summary, evidence, last_failure_at)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       RETURNING id`,
      [
        input.capabilityId,
        input.capabilityType ?? null,
        input.summary,
        JSON.stringify(input.evidence ?? {}),
        input.lastFailureAt ?? null,
      ],
    );
    res.status(201).json({ id: rows[0].id, status: "refreshed" });
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "validation", details: err.flatten() });
      return;
    }
    throw err;
  }
});

learningPatternsRoutes.get("/state", async (req: Request, res: Response) => {
  const capabilityId = typeof req.query.capabilityId === "string" ? req.query.capabilityId : null;
  const capabilityType = typeof req.query.capabilityType === "string" ? req.query.capabilityType : null;
  const failures = capabilityId
    ? await query(
      `SELECT * FROM learning.capability_failure_summary
        WHERE capability_id = $1
        ORDER BY refreshed_at DESC
        LIMIT 1`,
      [capabilityId],
    )
    : [];
  const patterns = await query(
    `SELECT * FROM learning.capability_type_pattern
      WHERE ($1::text IS NULL OR capability_type = $1)
         OR ($2::text IS NOT NULL AND capability_id = $2)
      ORDER BY updated_at DESC
      LIMIT 8`,
    [capabilityType, capabilityId],
  );
  res.json({
    failureSummary: failures[0] ?? null,
    patterns,
    degraded: false,
  });
});

learningPatternsRoutes.get("/similar-capabilities/:capabilityId", async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 5) || 5, 1), 20);
  const patterns = await query(
    `SELECT * FROM learning.capability_type_pattern
      WHERE capability_id IS NOT NULL AND capability_id <> $1
      ORDER BY updated_at DESC
      LIMIT $2`,
    [req.params.capabilityId, limit],
  );
  res.json({ items: patterns });
});

/**
 * M67 Slice 1A — Ensure the `learning.*` schema exists in the agent-service
 * database (was previously in its own `singularity_learning` DB). Called at
 * boot, idempotent. Matches the schema in
 * agent-and-tools/apps/learning-service/src/db.ts so existing wire contracts
 * (prompt-composer's GET /api/v1/state, mcp-server's tools/learning.ts)
 * continue to work unchanged.
 */
export async function ensureLearningSchema(): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS learning;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS learning.capability_failure_summary (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      capability_id TEXT NOT NULL,
      capability_type TEXT,
      summary TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_failure_at TIMESTAMPTZ,
      refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_learning_failure_capability
      ON learning.capability_failure_summary(capability_id, refreshed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_failure_type
      ON learning.capability_failure_summary(capability_type, refreshed_at DESC);

    CREATE TABLE IF NOT EXISTS learning.capability_type_pattern (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      capability_id TEXT,
      capability_type TEXT,
      pattern_kind TEXT NOT NULL DEFAULT 'outcome',
      summary TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      success_rate NUMERIC(6,4),
      observed_count INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_learning_pattern_type
      ON learning.capability_type_pattern(capability_type, pattern_kind, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_pattern_capability
      ON learning.capability_type_pattern(capability_id, updated_at DESC);
  `);
}
