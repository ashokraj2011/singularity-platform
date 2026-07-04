import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260704113000_capability_archive_reconcile/migration.sql",
);
const migration = fs.readFileSync(migrationPath, "utf8");

assert.match(
  migration,
  /UPDATE "CapabilityRepository"[\s\S]*?SET status = 'ARCHIVED'[\s\S]*?"pollIntervalSec" = NULL[\s\S]*?WHERE "capabilityId" IN \(SELECT id FROM archived\)/,
  "archive reconciliation should disable repository polling for already-archived capabilities",
);

assert.match(
  migration,
  /UPDATE "CapabilityKnowledgeSource"[\s\S]*?SET status = 'ARCHIVED'[\s\S]*?"pollIntervalSec" = NULL[\s\S]*?WHERE "capabilityId" IN \(SELECT id FROM archived\)/,
  "archive reconciliation should disable URL/document polling for already-archived capabilities",
);

assert.match(
  migration,
  /UPDATE "CapabilityKnowledgeArtifact"[\s\S]*?SET status = 'ARCHIVED'[\s\S]*?WHERE "capabilityId" IN \(SELECT id FROM archived\)[\s\S]*?AND status = 'ACTIVE'/,
  "archive reconciliation should make active knowledge artifacts read-only history",
);

assert.match(
  migration,
  /UPDATE "CapabilityLearningCandidate"[\s\S]*?SET status = 'REJECTED'[\s\S]*?"reviewedBy" = COALESCE\("reviewedBy", 'system:archive-reconcile'\)[\s\S]*?AND status = 'PENDING'/,
  "archive reconciliation should close pending learning review candidates",
);

assert.match(
  migration,
  /DELETE FROM "CapabilityLearningWorkerLock"[\s\S]*?WHERE "capabilityId" IN \(SELECT id FROM archived\)/,
  "archive reconciliation should cancel stale learning worker leases",
);

assert.match(
  migration,
  /INSERT INTO "CapabilityLearningStatus"[\s\S]*?'ARCHIVED'[\s\S]*?'Capability is archived; repository grounding is read-only\.'[\s\S]*?ON CONFLICT \("capabilityId"\) DO UPDATE[\s\S]*?status = 'ARCHIVED'[\s\S]*?"lastFailureCode" = NULL[\s\S]*?"lastFailureMessage" = NULL/,
  "archive reconciliation should upsert terminal ARCHIVED grounding status and clear stale failures",
);

assert.match(
  migration,
  /archiveCancelledLearningWorker/,
  "archive reconciliation diagnostics should mark cancelled learning workers for Operations/UI visibility",
);

console.log("capability archive reconcile migration contract tests passed");
