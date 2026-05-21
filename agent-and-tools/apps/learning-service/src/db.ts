import { Pool } from 'pg'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:singularity@localhost:5432/singularity_learning',
})

pool.on('error', err => {
  console.error('[learning-service] pg pool error', err)
})

export async function query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  const { rows } = await pool.query(sql, params)
  return rows as T[]
}

export async function ensureSchema(): Promise<void> {
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
  `)
}
