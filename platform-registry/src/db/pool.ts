import pg from 'pg'
import { config } from '../config.js'

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL })

/**
 * Apply any SQL files under db/ that haven't been applied yet.
 * Tracks history in a tiny `_migrations` table.
 */
export async function runMigrations(migrations: Array<{ name: string; sql: string }>): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM _migrations')
  const applied = new Set(rows.map((r) => r.name))
  for (const m of migrations) {
    if (applied.has(m.name)) continue
    await pool.query('BEGIN')
    try {
      await pool.query(m.sql)
      await pool.query('INSERT INTO _migrations (name) VALUES ($1)', [m.name])
      await pool.query('COMMIT')
      // eslint-disable-next-line no-console
      console.log(`[platform-registry] applied migration: ${m.name}`)
    } catch (err) {
      await pool.query('ROLLBACK')
      throw err
    }
  }
}
