import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://postgres:audit@localhost:5436/audit_governance",
});

pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[audit-gov] pg pool error", err);
});

export async function query<T extends Record<string, unknown>>(
  sql: string, params?: unknown[],
): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}

export async function queryOne<T extends Record<string, unknown>>(
  sql: string, params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function ensureEngineEvalTables(): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS audit_governance;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS audit_governance.engine_issues (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title                 TEXT NOT NULL,
      description           TEXT,
      severity              TEXT NOT NULL DEFAULT 'medium',
      status                TEXT NOT NULL DEFAULT 'open',
      category              TEXT,
      capability_id         TEXT,
      tenant_id             TEXT,
      first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      trace_count           INTEGER NOT NULL DEFAULT 0,
      affected_pct          NUMERIC(5,2),
      sample_trace_ids      TEXT[] DEFAULT '{}',
      cluster_fingerprint   TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      error_pattern         TEXT,
      root_cause            JSONB,
      proposed_fix          JSONB,
      resolved_at           TIMESTAMPTZ,
      resolved_by           TEXT,
      resolution_notes      TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS audit_governance.engine_evaluators (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      issue_id          UUID REFERENCES audit_governance.engine_issues(id) ON DELETE SET NULL,
      name              TEXT NOT NULL,
      description       TEXT,
      evaluator_type    TEXT NOT NULL DEFAULT 'llm_judge',
      criteria          JSONB NOT NULL DEFAULT '{}',
      evaluator_config  JSONB NOT NULL DEFAULT '{}',
      capability_id     TEXT,
      enabled           BOOLEAN NOT NULL DEFAULT true,
      fire_count        INTEGER NOT NULL DEFAULT 0,
      pass_count        INTEGER NOT NULL DEFAULT 0,
      fail_count        INTEGER NOT NULL DEFAULT 0,
      last_fired_at     TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS audit_governance.engine_datasets (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name            TEXT NOT NULL,
      description     TEXT,
      issue_id        UUID REFERENCES audit_governance.engine_issues(id) ON DELETE SET NULL,
      capability_id   TEXT,
      example_count   INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS audit_governance.engine_dataset_examples (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dataset_id      UUID NOT NULL REFERENCES audit_governance.engine_datasets(id) ON DELETE CASCADE,
      trace_id        TEXT NOT NULL,
      input           JSONB NOT NULL,
      expected_output JSONB,
      actual_output   JSONB,
      criteria        JSONB,
      verdict         TEXT,
      metadata        JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_engine_examples_dataset
      ON audit_governance.engine_dataset_examples(dataset_id);
    CREATE INDEX IF NOT EXISTS idx_engine_examples_trace
      ON audit_governance.engine_dataset_examples(trace_id);

    CREATE TABLE IF NOT EXISTS audit_governance.engine_eval_runs (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mode              TEXT NOT NULL,
      trace_id          TEXT,
      dataset_id        UUID REFERENCES audit_governance.engine_datasets(id) ON DELETE SET NULL,
      capability_id     TEXT,
      status            TEXT NOT NULL DEFAULT 'RUNNING',
      total_examples    INTEGER NOT NULL DEFAULT 0,
      total_evaluators  INTEGER NOT NULL DEFAULT 0,
      passed_count      INTEGER NOT NULL DEFAULT 0,
      failed_count      INTEGER NOT NULL DEFAULT 0,
      pass_rate         NUMERIC(6, 4) NOT NULL DEFAULT 0,
      metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at      TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS audit_governance.engine_eval_results (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      eval_run_id          UUID NOT NULL REFERENCES audit_governance.engine_eval_runs(id) ON DELETE CASCADE,
      evaluator_id         UUID REFERENCES audit_governance.engine_evaluators(id) ON DELETE SET NULL,
      trace_id             TEXT,
      dataset_example_id   UUID REFERENCES audit_governance.engine_dataset_examples(id) ON DELETE SET NULL,
      passed               BOOLEAN NOT NULL DEFAULT false,
      score                NUMERIC(6, 4),
      reason               TEXT NOT NULL DEFAULT '',
      evidence             JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- M38 — track resolution evidence so the lesson extractor can find the
    -- successful retry traces that closed an issue. ADD COLUMN IF NOT EXISTS
    -- means existing deployments upgrade non-destructively on next boot.
    ALTER TABLE audit_governance.engine_issues
      ADD COLUMN IF NOT EXISTS resolved_trace_ids   TEXT[]      DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS resolution_confirmed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS lesson_extracted_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS lesson_id            UUID;

    CREATE INDEX IF NOT EXISTS idx_engine_issues_lesson_pending
      ON audit_governance.engine_issues(resolution_confirmed_at)
      WHERE lesson_extracted_at IS NULL AND resolution_confirmed_at IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_engine_eval_runs_trace
      ON audit_governance.engine_eval_runs(trace_id);
    CREATE INDEX IF NOT EXISTS idx_engine_eval_runs_dataset
      ON audit_governance.engine_eval_runs(dataset_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_engine_eval_runs_cap_time
      ON audit_governance.engine_eval_runs(capability_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_engine_eval_results_run
      ON audit_governance.engine_eval_results(eval_run_id);
    CREATE INDEX IF NOT EXISTS idx_engine_eval_results_eval
      ON audit_governance.engine_eval_results(evaluator_id, created_at DESC);

    INSERT INTO audit_governance.engine_evaluators
      (name, description, evaluator_type, criteria, evaluator_config, enabled)
    SELECT 'builtin-latency-30s',
           'Built-in deterministic latency guard for trace evaluation.',
           'latency',
           '{"check":"llm_call_latency","operator":"lte","value":30000}'::jsonb,
           '{"max_latency_ms":30000}'::jsonb,
           true
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_governance.engine_evaluators WHERE name = 'builtin-latency-30s'
    );

    INSERT INTO audit_governance.engine_evaluators
      (name, description, evaluator_type, criteria, evaluator_config, enabled)
    SELECT 'builtin-token-budget-50000',
           'Built-in deterministic token count guard for trace evaluation.',
           'token_count',
           '{"check":"total_tokens","operator":"lte","value":50000}'::jsonb,
           '{"max_total_tokens":50000}'::jsonb,
           true
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_governance.engine_evaluators WHERE name = 'builtin-token-budget-50000'
    );

    INSERT INTO audit_governance.engine_evaluators
      (name, description, evaluator_type, criteria, evaluator_config, enabled)
    SELECT 'builtin-expected-output-contains',
           'Dataset evaluator that checks actual output contains the example expected output text.',
           'expected_output_contains',
           '{"check":"expected_output_contains"}'::jsonb,
           '{}'::jsonb,
           false
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_governance.engine_evaluators WHERE name = 'builtin-expected-output-contains'
    );
  `);
}
