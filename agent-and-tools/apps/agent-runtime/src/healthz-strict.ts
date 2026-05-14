/**
 * M28 boot-1 — strict health invariants for agent-runtime.
 *
 * Asserts at boot that:
 *   - DB is reachable
 *   - AgentTemplate.capabilityId / baseTemplateId / lockedReason columns exist
 *     (M23 governance — cross-service push fights have dropped these before)
 *   - tool.tools table exists (tool-service shares this DB)
 *
 * Returns 200 only if all pass; 503 + failing-check names otherwise.
 */
import { prisma } from "./config/prisma";

export interface InvariantResult {
  name: string;
  ok: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

type InvariantCheck = () => Promise<InvariantResult>;

const checks: InvariantCheck[] = [
  async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { name: "db_reachable", ok: true };
    } catch (err) {
      return { name: "db_reachable", ok: false, reason: (err as Error).message };
    }
  },

  // AgentTemplate M23 governance columns present (composer's push has dropped
  // these before; demo-prep mirror prevents it but boot check confirms).
  async () => {
    try {
      const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'AgentTemplate'
           AND column_name IN ('capabilityId', 'baseTemplateId', 'lockedReason')`;
      const found = rows.map((r) => r.column_name);
      const missing = ["capabilityId", "baseTemplateId", "lockedReason"].filter((c) => !found.includes(c));
      if (missing.length > 0) {
        return { name: "agent_template_columns", ok: false, reason: `missing columns on AgentTemplate: ${missing.join(", ")} — run prisma db push` };
      }
      return { name: "agent_template_columns", ok: true };
    } catch (err) {
      return { name: "agent_template_columns", ok: false, reason: (err as Error).message };
    }
  },

  // tool.tools — tool-service shares this DB; AgentRuntime references it
  // when resolving capability ↔ tool grants.
  async () => {
    try {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM information_schema.tables
         WHERE table_schema = 'tool' AND table_name = 'tools'`;
      if (Number(rows[0]?.count ?? 0) === 0) {
        return { name: "tool_tools_table", ok: false, reason: "tool.tools table missing — apply agent-and-tools/packages/db/init.sql" };
      }
      return { name: "tool_tools_table", ok: true };
    } catch (err) {
      return { name: "tool_tools_table", ok: false, reason: (err as Error).message };
    }
  },

  // M29 — assert PromptAssembly is NOT in agent-runtime's DB. The model
  // moved to prompt-composer; if it's still here, an older schema is loaded
  // and writes will pile up in the wrong place.
  async () => {
    try {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM information_schema.tables
         WHERE table_name = 'PromptAssembly'`;
      if (Number(rows[0]?.count ?? 0) > 0) {
        return {
          name: "no_composer_tables_present",
          ok: false,
          reason: "PromptAssembly exists in this DB — agent-runtime should not own composer tables after M29. Did you run prisma db push against the wrong DATABASE_URL?",
        };
      }
      return { name: "no_composer_tables_present", ok: true };
    } catch (err) {
      return { name: "no_composer_tables_present", ok: false, reason: (err as Error).message };
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
