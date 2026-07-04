/**
 * M28 boot-1 — strict health invariants for agent-runtime.
 *
 * Asserts at boot that:
 *   - DB is reachable
 *   - AgentTemplate.capabilityId / baseTemplateId / lockedReason columns exist
 *     (M23 governance — cross-service push fights have dropped these before)
 *   - CapabilityLearningStatus / CapabilityLearningWorkerLock exist
 *     (capability refresh/sync must fail early if migration/db-push drifted)
 *   - Archived capabilities have terminal lifecycle state
 *     (no active polling/artifacts/candidates/worker locks; grounding is ARCHIVED)
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

  // Capability learning/grounding tables. Missing these makes the capability
  // detail page brittle: refresh/sync can reach runtime code before the DB
  // has the durable status or multi-replica lock tables it now depends on.
  async () => {
    try {
      const rows = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND (
             (table_name = 'CapabilityLearningStatus'
              AND column_name IN ('capabilityId', 'status', 'lastAttemptAt', 'sourceFingerprint', 'diagnostics'))
             OR
             (table_name = 'CapabilityLearningWorkerLock'
              AND column_name IN ('capabilityId', 'operation', 'ownerId', 'startedAt', 'expiresAt'))
           )`;
      const found = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
      const required = [
        "CapabilityLearningStatus.capabilityId",
        "CapabilityLearningStatus.status",
        "CapabilityLearningStatus.lastAttemptAt",
        "CapabilityLearningStatus.sourceFingerprint",
        "CapabilityLearningStatus.diagnostics",
        "CapabilityLearningWorkerLock.capabilityId",
        "CapabilityLearningWorkerLock.operation",
        "CapabilityLearningWorkerLock.ownerId",
        "CapabilityLearningWorkerLock.startedAt",
        "CapabilityLearningWorkerLock.expiresAt",
      ];
      const missing = required.filter((key) => !found.has(key));
      if (missing.length > 0) {
        return {
          name: "capability_learning_tables",
          ok: false,
          reason: `missing capability learning table columns: ${missing.join(", ")} — run prisma db push or prisma migrate deploy for agent-runtime`,
        };
      }
      return { name: "capability_learning_tables", ok: true };
    } catch (err) {
      return { name: "capability_learning_tables", ok: false, reason: (err as Error).message };
    }
  },

  // Archived capabilities must be terminal. Dirty local databases used to get
  // into a half-archived state: the Capability row was ARCHIVED, but polling
  // rows, candidates, worker locks, or grounding status still looked active.
  // That makes the UI feel random ("pending" or duplicate-looking cards after
  // archive). This check points operators at the reconcile migration instead of
  // letting those rows keep surprising the runtime.
  async () => {
    try {
      const rows = await prisma.$queryRaw<Array<{
        active_repositories: bigint;
        active_knowledge_sources: bigint;
        active_artifacts: bigint;
        pending_candidates: bigint;
        worker_locks: bigint;
        status_drift: bigint;
        sample_ids: string[] | null;
      }>>`
        WITH archived AS (
          SELECT id
          FROM "Capability"
          WHERE status = 'ARCHIVED'
        ),
        drift_ids AS (
          SELECT r."capabilityId" AS id
          FROM "CapabilityRepository" r
          JOIN archived a ON a.id = r."capabilityId"
          WHERE r.status <> 'ARCHIVED' OR r."pollIntervalSec" IS NOT NULL

          UNION

          SELECT s."capabilityId" AS id
          FROM "CapabilityKnowledgeSource" s
          JOIN archived a ON a.id = s."capabilityId"
          WHERE s.status <> 'ARCHIVED' OR s."pollIntervalSec" IS NOT NULL

          UNION

          SELECT k."capabilityId" AS id
          FROM "CapabilityKnowledgeArtifact" k
          JOIN archived a ON a.id = k."capabilityId"
          WHERE k.status = 'ACTIVE'

          UNION

          SELECT c."capabilityId" AS id
          FROM "CapabilityLearningCandidate" c
          JOIN archived a ON a.id = c."capabilityId"
          WHERE c.status = 'PENDING'

          UNION

          SELECT l."capabilityId" AS id
          FROM "CapabilityLearningWorkerLock" l
          JOIN archived a ON a.id = l."capabilityId"

          UNION

          SELECT a.id
          FROM archived a
          LEFT JOIN "CapabilityLearningStatus" s ON s."capabilityId" = a.id
          WHERE s.id IS NULL OR s.status <> 'ARCHIVED'
        )
        SELECT
          (SELECT count(*) FROM "CapabilityRepository" r JOIN archived a ON a.id = r."capabilityId" WHERE r.status <> 'ARCHIVED' OR r."pollIntervalSec" IS NOT NULL) AS active_repositories,
          (SELECT count(*) FROM "CapabilityKnowledgeSource" s JOIN archived a ON a.id = s."capabilityId" WHERE s.status <> 'ARCHIVED' OR s."pollIntervalSec" IS NOT NULL) AS active_knowledge_sources,
          (SELECT count(*) FROM "CapabilityKnowledgeArtifact" k JOIN archived a ON a.id = k."capabilityId" WHERE k.status = 'ACTIVE') AS active_artifacts,
          (SELECT count(*) FROM "CapabilityLearningCandidate" c JOIN archived a ON a.id = c."capabilityId" WHERE c.status = 'PENDING') AS pending_candidates,
          (SELECT count(*) FROM "CapabilityLearningWorkerLock" l JOIN archived a ON a.id = l."capabilityId") AS worker_locks,
          (SELECT count(*) FROM archived a LEFT JOIN "CapabilityLearningStatus" s ON s."capabilityId" = a.id WHERE s.id IS NULL OR s.status <> 'ARCHIVED') AS status_drift,
          (SELECT array_agg(id) FROM (SELECT id FROM drift_ids ORDER BY id LIMIT 5) samples) AS sample_ids
      `;
      const row = rows[0];
      const counts = {
        activeRepositories: Number(row?.active_repositories ?? 0),
        activeKnowledgeSources: Number(row?.active_knowledge_sources ?? 0),
        activeArtifacts: Number(row?.active_artifacts ?? 0),
        pendingCandidates: Number(row?.pending_candidates ?? 0),
        workerLocks: Number(row?.worker_locks ?? 0),
        statusDrift: Number(row?.status_drift ?? 0),
      };
      const drift = Object.values(counts).reduce((sum, count) => sum + count, 0);
      if (drift > 0) {
        return {
          name: "archived_capability_lifecycle",
          ok: false,
          reason: "archived capability lifecycle drift detected — run prisma migrate deploy for agent-runtime to apply capability_archive_reconcile",
          details: {
            ...counts,
            sampleCapabilityIds: row?.sample_ids ?? [],
          },
        };
      }
      return { name: "archived_capability_lifecycle", ok: true, details: counts };
    } catch (err) {
      return { name: "archived_capability_lifecycle", ok: false, reason: (err as Error).message };
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

  // M29 — composer-owned models (PromptAssembly etc.) are mirror-declared in
  // agent-runtime's schema so Prisma `db push` doesn't drop them from the
  // shared Postgres. That means agent-runtime's generated client legitimately
  // exposes them as a side-effect of the schema mirror. The CI source-code
  // grep (m29-schema-ownership job) is the real guard: it ensures
  // agent-runtime code never imports/calls `prisma.<composer-owned>`. No
  // runtime invariant needed.
];

export async function runInvariantChecks(): Promise<{ ok: boolean; checks: InvariantResult[] }> {
  const results = await Promise.all(checks.map(async (c) => {
    try { return await c(); }
    catch (err) { return { name: "unknown", ok: false, reason: `check threw: ${(err as Error).message}` }; }
  }));
  return { ok: results.every((r) => r.ok), checks: results };
}
