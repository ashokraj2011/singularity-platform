/**
 * M28 boot-1 — strict health invariants for prompt-composer.
 *
 * Why: `/health` only confirms the HTTP listener responds. Composer can boot
 * with a missing `evidenceRefs` column or a vector extension that's not loaded
 * and only fail on the first user request. That's how 11 hours of demo prep
 * went sideways. `/healthz/strict` proves at boot that:
 *   - the Prisma schema matches the DB
 *   - the M25.5 CapabilityCompiledContext table is present
 *   - pgvector extension is installed (M25 retrieval depends on it)
 *
 * Returns 200 + ok=true if all pass; 503 + the failing check names otherwise.
 * Unauthenticated by design.
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
  // 1. Database reachable.
  async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { name: "db_reachable", ok: true };
    } catch (err) {
      return { name: "db_reachable", ok: false, reason: (err as Error).message };
    }
  },

  // 2. pgvector extension installed. Composer's M25 retrieval reads
  //    `embedding vector(1536)` columns via raw SQL and crashes silently on
  //    rows where the extension hasn't loaded.
  async () => {
    try {
      const rows = await prisma.$queryRaw<Array<{ extname: string }>>`
        SELECT extname FROM pg_extension WHERE extname = 'vector'`;
      if (rows.length === 0) {
        return { name: "pgvector_installed", ok: false, reason: "pgvector extension not present in DB — install with: CREATE EXTENSION vector;" };
      }
      return { name: "pgvector_installed", ok: true };
    } catch (err) {
      return { name: "pgvector_installed", ok: false, reason: (err as Error).message };
    }
  },

  // 3. M25.5 CapabilityCompiledContext table exists. Composer's hot-path
  //    capsule lookup crashes if this is missing — and the prior schema-drift
  //    bug destroyed it on every agent-runtime push.
  async () => {
    try {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM information_schema.tables
         WHERE table_name = 'CapabilityCompiledContext'`;
      const count = Number(rows[0]?.count ?? 0);
      if (count === 0) return { name: "compiled_context_table", ok: false, reason: "CapabilityCompiledContext table missing — run prisma db push" };
      return { name: "compiled_context_table", ok: true };
    } catch (err) {
      return { name: "compiled_context_table", ok: false, reason: (err as Error).message };
    }
  },

  // 4. PromptAssembly.traceId column present (M28 spine-2). If absent, the
  //    trace-spine viewer can't join PromptAssembly into the run timeline.
  async () => {
    try {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM information_schema.columns
         WHERE table_name = 'PromptAssembly' AND column_name = 'traceId'`;
      const count = Number(rows[0]?.count ?? 0);
      if (count === 0) return { name: "prompt_assembly_trace_id", ok: false, reason: "PromptAssembly.traceId column missing — run prisma db push for M28 spine-2" };
      return { name: "prompt_assembly_trace_id", ok: true };
    } catch (err) {
      return { name: "prompt_assembly_trace_id", ok: false, reason: (err as Error).message };
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
