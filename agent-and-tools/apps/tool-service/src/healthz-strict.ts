/**
 * M28 boot-1 — strict health invariants for tool-service.
 *
 * Asserts at boot:
 *   - DB reachable
 *   - tool.tools table exists
 *   - tool.tools has >= 10 seeded core tools (else cf discovery returns
 *     nothing → LLM sees no tools → silent no-op runs, exactly what happened
 *     during demo prep before we re-applied init.sql)
 *
 * Returns 200 only if all pass; 503 + failing-check names otherwise.
 */
import { query } from "./database";

export interface InvariantResult {
  name: string;
  ok: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

type InvariantCheck = () => Promise<InvariantResult>;

const MIN_SEEDED_TOOLS = 10;

const checks: InvariantCheck[] = [
  async () => {
    try { await query("SELECT 1"); return { name: "db_reachable", ok: true }; }
    catch (err) { return { name: "db_reachable", ok: false, reason: (err as Error).message }; }
  },

  async () => {
    try {
      const rows = await query<{ count: string }>(
        "SELECT count(*) AS count FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2",
        ["tool", "tools"],
      );
      if (Number(rows[0]?.count ?? 0) === 0) {
        return { name: "tool_tools_table", ok: false, reason: "tool.tools table missing — apply agent-and-tools/packages/db/init.sql" };
      }
      return { name: "tool_tools_table", ok: true };
    } catch (err) {
      return { name: "tool_tools_table", ok: false, reason: (err as Error).message };
    }
  },

  async () => {
    try {
      const rows = await query<{ count: string }>("SELECT count(*) AS count FROM tool.tools");
      const count = Number(rows[0]?.count ?? 0);
      if (count < MIN_SEEDED_TOOLS) {
        return { name: "core_tools_seeded", ok: false, reason: `tool.tools has only ${count} rows (need >= ${MIN_SEEDED_TOOLS}) — seed-core-tools.ts likely failed`, details: { count, min: MIN_SEEDED_TOOLS } };
      }
      return { name: "core_tools_seeded", ok: true, details: { count } };
    } catch (err) {
      return { name: "core_tools_seeded", ok: false, reason: (err as Error).message };
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
