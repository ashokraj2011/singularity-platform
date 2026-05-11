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
