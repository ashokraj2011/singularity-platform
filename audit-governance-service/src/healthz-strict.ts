/**
 * M28 boot-1 — strict health invariants for audit-governance-service.
 *
 * Why: audit-gov is everyone's silent dependency. When its schema isn't
 * applied (which happened during demo prep), `audit_governance.audit_events`
 * doesn't exist, INSERTs from cf/mcp/composer fail silently (fire-and-forget),
 * and no one notices for 11 hours.
 *
 * Asserts at boot:
 *   - DB reachable
 *   - audit_governance schema present
 *   - audit_events table present
 *   - gen_random_uuid() works (pgcrypto extension loaded)
 *
 * Returns 200 only if all pass; 503 + failing-check names otherwise.
 */
import { query } from "./db";

export interface InvariantResult {
  name: string;
  ok: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

type InvariantCheck = () => Promise<InvariantResult>;

const checks: InvariantCheck[] = [
  async () => {
    try { await query("SELECT 1"); return { name: "db_reachable", ok: true }; }
    catch (err) { return { name: "db_reachable", ok: false, reason: (err as Error).message }; }
  },

  async () => {
    try {
      const rows = await query<{ count: string }>(
        "SELECT count(*) AS count FROM information_schema.schemata WHERE schema_name=$1",
        ["audit_governance"],
      );
      if (Number(rows[0]?.count ?? 0) === 0) {
        return { name: "audit_governance_schema", ok: false, reason: "audit_governance schema missing — apply audit-governance-service/db/init.sql" };
      }
      return { name: "audit_governance_schema", ok: true };
    } catch (err) {
      return { name: "audit_governance_schema", ok: false, reason: (err as Error).message };
    }
  },

  async () => {
    try {
      const rows = await query<{ count: string }>(
        "SELECT count(*) AS count FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2",
        ["audit_governance", "audit_events"],
      );
      if (Number(rows[0]?.count ?? 0) === 0) {
        return { name: "audit_events_table", ok: false, reason: "audit_governance.audit_events table missing — apply init.sql" };
      }
      return { name: "audit_events_table", ok: true };
    } catch (err) {
      return { name: "audit_events_table", ok: false, reason: (err as Error).message };
    }
  },

  async () => {
    try {
      const rows = await query<{ id: string }>("SELECT gen_random_uuid() AS id");
      if (!rows[0]?.id) return { name: "gen_random_uuid_works", ok: false, reason: "gen_random_uuid() returned no row — pgcrypto extension likely missing" };
      return { name: "gen_random_uuid_works", ok: true };
    } catch (err) {
      return { name: "gen_random_uuid_works", ok: false, reason: `pgcrypto extension likely missing: ${(err as Error).message}` };
    }
  },
];

export async function runInvariantChecks(): Promise<{ ok: boolean; checks: InvariantResult[] }> {
  const results = await Promise.all(checks.map(async (c) => {
    try { return await c(); }
    catch (err) { return { name: "unknown", ok: false, reason: `check threw: ${(err as Error).message}` }; }
  }));
  return { ok: results.every((r) => r.ok), checks: results };
}
