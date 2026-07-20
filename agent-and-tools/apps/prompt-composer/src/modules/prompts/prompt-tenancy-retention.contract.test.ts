/**
 * D3 — tenancy + retention for stored prompt text.
 *
 * Covers, in order:
 *   1. `tenantId` is OPTIONAL on both compose inputs, so every existing
 *      caller still composes unchanged.
 *   2. When supplied it is persisted onto the PromptAssembly row (both
 *      create sites), and it participates in the preview reuse key.
 *   3. The retention sweep NULLs contentSnapshot, PRESERVES layerHash, and
 *      deletes no rows — driven behaviourally against an in-memory double.
 *   4. The migration is additive only.
 *   5. startup.sh actually applies directory-format migrations. Without this
 *      the migration in (4) is silently skipped and the column never lands.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { composeSchema } from "../compose/compose.schemas";
import { assembleSchema } from "./prompt.schemas";

// snapshot-retention transitively imports the composer config, which strictly
// validates env at load. Dummy connection strings (validation never connects)
// keep this test self-contained in the test:contracts chain. TTL is pinned to
// 10 days BEFORE the require so we assert against a known cutoff rather than
// the 30-day default.
process.env.DATABASE_URL ??= "postgresql://u:p@127.0.0.1:5432/db";
process.env.DATABASE_URL_RUNTIME_READ ??= "postgresql://u:p@127.0.0.1:5432/db";
process.env.PROMPT_SNAPSHOT_TTL_DAYS = "10";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { purgeExpiredSnapshots, snapshotCutoff } =
  require("./snapshot-retention") as typeof import("./snapshot-retention");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { snapshotRetentionConfig } =
  require("./snapshot-retention.config") as typeof import("./snapshot-retention.config");

const composeSrc  = readFileSync("src/modules/compose/compose.service.ts", "utf8");
const assemblySrc = readFileSync("src/modules/prompts/prompt-assembly.service.ts", "utf8");
const retentionSrc = readFileSync("src/modules/prompts/snapshot-retention.ts", "utf8");
const schemaSrc   = readFileSync("prisma/schema.prisma", "utf8");
const startupSrc  = readFileSync("bin/startup.sh", "utf8");
const migrationSrc = readFileSync(
  path.join(process.cwd(), "prisma/migrations/20260720120000_prompt_assembly_tenancy/migration.sql"),
  "utf8",
);

/** SQL with `--` comment lines stripped. The prose in this migration's header
 *  legitimately contains phrases like "NOT NULL", so the additive-only
 *  assertions must run against executable statements only. */
const migrationStatements = migrationSrc
  .split("\n")
  .filter(line => !line.trimStart().startsWith("--"))
  .join("\n");

const BASE_COMPOSE_INPUT = {
  agentTemplateId: "11111111-1111-4111-8111-111111111111",
  task: "summarise the incident",
  workflowContext: { instanceId: "inst-1", nodeId: "node-1" },
};

const BASE_ASSEMBLE_INPUT = {
  agentTemplateId: "11111111-1111-4111-8111-111111111111",
  task: "summarise the incident",
};

// ─── in-memory double for the retention sweep ────────────────────────────

interface FakeLayerRow {
  id: string;
  layerHash: string | null;
  contentSnapshot: string | null;
  included: boolean;
  assemblyCreatedAt: Date;
}

/** Implements ONLY promptAssemblyLayer.updateMany, and applies the real
 *  where-clause semantics the sweep relies on, so the assertions below are
 *  about behaviour rather than about the shape of a recorded call. */
function makeFakeClient(rows: FakeLayerRow[]) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      promptAssemblyLayer: {
        async updateMany(args: {
          where: {
            contentSnapshot?: { not: null };
            promptAssembly?: { createdAt: { lt: Date } };
          };
          data: { contentSnapshot: null };
        }): Promise<{ count: number }> {
          calls.push(args);
          let count = 0;
          for (const row of rows) {
            if (args.where.contentSnapshot?.not === null && row.contentSnapshot === null) continue;
            const before = args.where.promptAssembly?.createdAt.lt;
            if (before && !(row.assemblyCreatedAt.getTime() < before.getTime())) continue;
            Object.assign(row, args.data);
            count += 1;
          }
          return { count };
        },
      },
    },
  };
}

async function main(): Promise<void> {
  // ── 1. tenantId is optional on both inputs ──────────────────────────────
  const composedWithout = composeSchema.parse(BASE_COMPOSE_INPUT);
  assert.equal(
    composedWithout.tenantId, undefined,
    "compose input must parse with no tenantId — existing callers must not break",
  );
  const assembledWithout = assembleSchema.parse(BASE_ASSEMBLE_INPUT);
  assert.equal(
    assembledWithout.tenantId, undefined,
    "assemble input must parse with no tenantId",
  );

  // ── 2. …and carried through when supplied ───────────────────────────────
  assert.equal(
    composeSchema.parse({ ...BASE_COMPOSE_INPUT, tenantId: "tenant-abc" }).tenantId,
    "tenant-abc",
    "compose input must carry a supplied tenantId",
  );
  assert.equal(
    assembleSchema.parse({ ...BASE_ASSEMBLE_INPUT, tenantId: "tenant-abc" }).tenantId,
    "tenant-abc",
    "assemble input must carry a supplied tenantId",
  );
  // Not a uuid() — tenant ids are not uniformly uuids across the platform.
  assert.equal(
    composeSchema.parse({ ...BASE_COMPOSE_INPUT, tenantId: "acme-prod" }).tenantId,
    "acme-prod",
    "non-uuid tenant ids must be accepted",
  );
  assert.throws(
    () => composeSchema.parse({ ...BASE_COMPOSE_INPUT, tenantId: "" }),
    "an empty tenantId is a caller bug, not an anonymous compose",
  );

  // Persisted at BOTH PromptAssembly create sites.
  assert.match(
    composeSrc,
    /tenantId:\s*input\.tenantId\s*\?\?\s*null/,
    "compose.service must persist tenantId on the PromptAssembly row",
  );
  assert.match(
    assemblySrc,
    /tenantId:\s*input\.tenantId\s*\?\?\s*null/,
    "prompt-assembly.service must persist tenantId on the PromptAssembly row",
  );
  // Reuse key includes tenant, or a preview compose could hand back another
  // tenant's row. Two occurrences in compose.service: the findFirst where and
  // the create data.
  assert.equal(
    (composeSrc.match(/tenantId:\s*input\.tenantId\s*\?\?\s*null/g) || []).length, 2,
    "tenantId must appear in BOTH the reuse lookup and the create payload",
  );

  // ── 3. schema columns + indexes ─────────────────────────────────────────
  assert.match(schemaSrc, /tenantId\s+String\?/, "PromptAssembly.tenantId must be nullable");
  assert.match(schemaSrc, /gatewayCallId\s+String\?/, "PromptAssembly.gatewayCallId must be nullable");
  assert.match(schemaSrc, /@@index\(\[tenantId, createdAt\]\)/, "tenantId must be indexed with createdAt");
  assert.match(schemaSrc, /@@index\(\[gatewayCallId\]\)/, "gatewayCallId must be indexed");

  // ── 4. retention sweep: nulls text, keeps hash, deletes nothing ─────────
  const now = new Date("2026-07-20T00:00:00.000Z");
  assert.equal(
    snapshotCutoff(now).toISOString(), "2026-07-10T00:00:00.000Z",
    "cutoff must honour PROMPT_SNAPSHOT_TTL_DAYS (10 days here)",
  );

  const rows: FakeLayerRow[] = [
    // Expired: assembly is 40 days old.
    { id: "old-1", layerHash: "hash-old-1", contentSnapshot: "SYSTEM: secret prompt text",
      included: true, assemblyCreatedAt: new Date("2026-06-10T00:00:00.000Z") },
    { id: "old-2", layerHash: "hash-old-2", contentSnapshot: "USER: another prompt",
      included: false, assemblyCreatedAt: new Date("2026-06-10T00:00:00.000Z") },
    // Already purged — must not be re-touched.
    { id: "old-3", layerHash: "hash-old-3", contentSnapshot: null,
      included: true, assemblyCreatedAt: new Date("2026-06-10T00:00:00.000Z") },
    // Fresh: 2 days old, inside the window.
    { id: "new-1", layerHash: "hash-new-1", contentSnapshot: "SYSTEM: recent prompt",
      included: true, assemblyCreatedAt: new Date("2026-07-18T00:00:00.000Z") },
  ];
  const rowCountBefore = rows.length;
  const fake = makeFakeClient(rows);

  const purged = await purgeExpiredSnapshots({ now, client: fake.client });

  assert.equal(purged, 2, "only the two expired, still-populated snapshots are purged");
  assert.equal(rows.length, rowCountBefore, "the sweep must NOT delete rows");

  const byId = new Map(rows.map(r => [r.id, r]));
  assert.equal(byId.get("old-1")!.contentSnapshot, null, "expired snapshot text must be nulled");
  assert.equal(byId.get("old-2")!.contentSnapshot, null, "expired snapshot text must be nulled");
  assert.equal(byId.get("new-1")!.contentSnapshot, "SYSTEM: recent prompt", "in-window text must survive");

  // The hash is the whole point: auditability outlives the text.
  assert.equal(byId.get("old-1")!.layerHash, "hash-old-1", "layerHash must be preserved");
  assert.equal(byId.get("old-2")!.layerHash, "hash-old-2", "layerHash must be preserved");
  assert.equal(byId.get("old-3")!.layerHash, "hash-old-3", "layerHash must be preserved");
  // Every other column untouched.
  assert.equal(byId.get("old-2")!.included, false, "unrelated columns must be untouched");

  // Only contentSnapshot is written.
  const updateArgs = fake.calls[0] as { data: Record<string, unknown> };
  assert.deepEqual(
    Object.keys(updateArgs.data), ["contentSnapshot"],
    "the sweep must write exactly one column",
  );
  // Re-running is a no-op — proves the `contentSnapshot: { not: null }` guard
  // stops the sweep rewriting the whole historical table every cycle.
  assert.equal(
    await purgeExpiredSnapshots({ now, client: fake.client }), 0,
    "a second sweep over the same rows must purge nothing",
  );

  // Structural: there is no delete path in the retention module at all.
  assert.doesNotMatch(
    retentionSrc, /delete(Many)?\s*\(/,
    "the retention module must never delete rows",
  );

  // Bounded config — a garbage TTL must fall back to the documented 30 days,
  // never a NaN cutoff (which would match every row).
  process.env.PROMPT_SNAPSHOT_TTL_DAYS = "bad";
  assert.equal(snapshotRetentionConfig().ttlDays, 30, "bad TTL falls back to 30d");
  process.env.PROMPT_SNAPSHOT_TTL_DAYS = "0";
  assert.equal(snapshotRetentionConfig().ttlDays, 30, "a 0-day TTL is rejected, not honoured");
  process.env.PROMPT_SNAPSHOT_TTL_DAYS = "99999";
  assert.equal(snapshotRetentionConfig().ttlDays, 3_650, "absurd TTL clamps to the max");
  process.env.PROMPT_SNAPSHOT_TTL_DAYS = "10";

  // ── 5. migration is additive only ───────────────────────────────────────
  assert.doesNotMatch(migrationStatements, /\bDROP\b/i, "migration must not DROP anything");
  assert.doesNotMatch(migrationStatements, /\bNOT\s+NULL\b/i, "migration must not add NOT NULL");
  assert.doesNotMatch(migrationStatements, /\b(DELETE|TRUNCATE|UPDATE)\b/i, "migration must not rewrite data");
  assert.match(migrationStatements, /ALTER TABLE "PromptAssembly" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;/);
  assert.match(migrationStatements, /ALTER TABLE "PromptAssembly" ADD COLUMN IF NOT EXISTS "gatewayCallId" TEXT;/);
  assert.match(migrationStatements, /CREATE INDEX IF NOT EXISTS "PromptAssembly_tenantId_createdAt_idx"/);
  assert.match(migrationStatements, /CREATE INDEX IF NOT EXISTS "PromptAssembly_gatewayCallId_idx"/);

  // ── 6. startup.sh must actually reach directory-format migrations ───────
  // This service's wrapper globbed only `migrations/*.sql` before D3, so a
  // `<timestamp>_<name>/migration.sql` file was silently never applied while
  // the Prisma client WAS regenerated from schema.prisma — a column the
  // client expects and the DB never gets. Guard the fix.
  assert.match(
    startupSrc, /ls -d "\$MIGRATIONS_DIR"\/\*\//,
    "startup.sh must iterate directory-format migrations",
  );
  assert.match(
    startupSrc, /\$dir\/migration\.sql/,
    "startup.sh must apply <timestamp>_<name>/migration.sql",
  );

  console.log("prompt-tenancy-retention.contract.test.ts: OK");
}

void main();
