import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src/healthz-strict.ts"), "utf8");

assert.match(
  source,
  /CapabilityLearningStatus \/ CapabilityLearningWorkerLock exist[\s\S]*?capability refresh\/sync must fail early if migration\/db-push drifted/,
  "strict health should document the capability learning table invariant",
);

assert.match(
  source,
  /Archived capabilities have terminal lifecycle state[\s\S]*?no active polling\/artifacts\/candidates\/worker locks; grounding is ARCHIVED/,
  "strict health should document the archived capability lifecycle invariant",
);

assert.match(
  source,
  /CapabilityLearningStatus[\s\S]*?CapabilityLearningWorkerLock[\s\S]*?name: "capability_learning_tables"/,
  "strict health should include a named capability learning table check",
);

assert.match(
  source,
  /table_schema = 'public'[\s\S]*?table_name = 'CapabilityLearningStatus'[\s\S]*?column_name IN \('capabilityId', 'status', 'lastAttemptAt', 'sourceFingerprint', 'diagnostics'\)[\s\S]*?table_name = 'CapabilityLearningWorkerLock'[\s\S]*?column_name IN \('capabilityId', 'operation', 'ownerId', 'startedAt', 'expiresAt'\)/,
  "strict health should verify the required status and worker-lock columns",
);

assert.match(
  source,
  /missing capability learning table columns:[\s\S]*?run prisma db push or prisma migrate deploy for agent-runtime/,
  "strict health should return an actionable migration fix when learning tables are missing",
);

assert.match(
  source,
  /name: "archived_capability_lifecycle"/,
  "strict health should include a named archived capability lifecycle drift check",
);

assert.match(
  source,
  /"CapabilityRepository"[\s\S]*?r\.status <> 'ARCHIVED' OR r\."pollIntervalSec" IS NOT NULL[\s\S]*?"CapabilityKnowledgeSource"[\s\S]*?s\.status <> 'ARCHIVED' OR s\."pollIntervalSec" IS NOT NULL[\s\S]*?"CapabilityKnowledgeArtifact"[\s\S]*?k\.status = 'ACTIVE'/,
  "archived lifecycle check should catch active repository, URL source, and knowledge artifact drift",
);

assert.match(
  source,
  /"CapabilityLearningCandidate"[\s\S]*?c\.status = 'PENDING'[\s\S]*?"CapabilityLearningWorkerLock"[\s\S]*?LEFT JOIN "CapabilityLearningStatus"[\s\S]*?s\.id IS NULL OR s\.status <> 'ARCHIVED'/,
  "archived lifecycle check should catch pending candidates, worker locks, and non-terminal grounding status",
);

assert.match(
  source,
  /archived capability lifecycle drift detected[\s\S]*?prisma migrate deploy[\s\S]*?capability_archive_reconcile/,
  "archived lifecycle check should return the reconcile migration fix",
);

console.log("agent-runtime strict health contract tests passed");
