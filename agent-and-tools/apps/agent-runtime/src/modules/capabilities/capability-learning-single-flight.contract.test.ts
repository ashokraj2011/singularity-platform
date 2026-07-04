import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");
const schema = fs.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
const migration = fs.readFileSync(
  path.join(process.cwd(), "prisma/migrations/20260704110000_capability_learning_worker_lock/migration.sql"),
  "utf8",
);

assert.match(
  service,
  /const CAPABILITY_LEARNING_RUN_STALE_MS = env\.CAPABILITY_LEARNING_RUN_STALE_MS;/,
  "learning refresh single-flight guard should use the centrally bounded stale-run escape hatch",
);

assert.match(
  service,
  /async function claimCapabilityLearningWorker\(capabilityId: string, operation: CapabilityLearningWorkerOperation\): Promise<\(\) => Promise<void>>[\s\S]*?INSERT INTO "CapabilityLearningWorkerLock"[\s\S]*?SELECT \$\{uuidv4\(\)\}, \$\{capabilityId\}, \$\{operation\}, \$\{ownerId\}[\s\S]*?FROM "Capability" c[\s\S]*?WHERE c\.id = \$\{capabilityId\}[\s\S]*?AND c\.status <> 'ARCHIVED'[\s\S]*?ON CONFLICT \("capabilityId"\) DO UPDATE[\s\S]*?WHERE "CapabilityLearningWorkerLock"\."expiresAt" <= CURRENT_TIMESTAMP[\s\S]*?RETURNING "ownerId"/,
  "learning-worker runs should claim a durable DB lease with stale recovery and fail closed if the capability was archived before the insert",
);

assert.match(
  service,
  /if \(claim\[0\]\?\.ownerId !== ownerId\) \{[\s\S]*?await requireActiveCapability\(capabilityId, "Cannot run learning worker for an archived capability\."\);[\s\S]*?SELECT "operation", "expiresAt"[\s\S]*?already running for this capability/,
  "learning-worker lease failures should distinguish archived or missing capability from an active competing worker",
);

assert.match(
  service,
  /SELECT "operation", "expiresAt"[\s\S]*?FROM "CapabilityLearningWorkerLock"[\s\S]*?already running for this capability[\s\S]*?DELETE FROM "CapabilityLearningWorkerLock"[\s\S]*?WHERE "capabilityId" = \$\{capabilityId\}[\s\S]*?AND "ownerId" = \$\{ownerId\}/,
  "learning-worker lease conflicts should report the active operation and releases must be scoped to the lease owner",
);

assert.match(
  schema,
  /learningWorkerLock CapabilityLearningWorkerLock\?[\s\S]*?model CapabilityLearningWorkerLock \{[\s\S]*?capabilityId String\s+@unique[\s\S]*?operation\s+String[\s\S]*?ownerId\s+String[\s\S]*?expiresAt\s+DateTime[\s\S]*?@@index\(\[expiresAt\]\)/,
  "Prisma schema should model a capability-scoped learning-worker lock with expiry",
);

assert.match(
  migration,
  /CREATE TABLE IF NOT EXISTS "CapabilityLearningWorkerLock"[\s\S]*?"capabilityId" TEXT NOT NULL[\s\S]*?"ownerId" TEXT NOT NULL[\s\S]*?"expiresAt" TIMESTAMP\(3\) NOT NULL[\s\S]*?CREATE UNIQUE INDEX IF NOT EXISTS "CapabilityLearningWorkerLock_capabilityId_key"[\s\S]*?FOREIGN KEY \("capabilityId"\) REFERENCES "Capability"\("id"\)/,
  "migration should create an idempotent durable learning-worker lock table with a capability unique key",
);

assert.match(
  service,
  /async function recordLearningAttempt\([\s\S]*?\): Promise<\{ claimed: boolean; status: CapabilityLearningGroundingStatus; activeRepositoryCount: number \}>[\s\S]*?const status: CapabilityLearningGroundingStatus = sourceState\.activeRepositoryCount > 0 \? "RUNNING" : "NOT_CONFIGURED"/,
  "recordLearningAttempt should expose whether a repository refresh claimed the durable RUNNING state",
);

assert.match(
  service,
  /withActiveCapabilityLearningStatusWrite\(capabilityId, async \(tx\) => \{[\s\S]*?INSERT INTO "CapabilityLearningStatus" \("id", "capabilityId", "status", "createdAt", "updatedAt"\)[\s\S]*?ON CONFLICT \("capabilityId"\) DO NOTHING[\s\S]*?tx\.capabilityLearningStatus\.updateMany\(\{[\s\S]*?status: \{ not: "RUNNING" \}[\s\S]*?lastAttemptAt: null[\s\S]*?lastAttemptAt: \{ lt: staleBefore \}/,
  "RUNNING claims should be row-locked, atomic, and should only override stale or non-running status rows",
);

assert.match(
  service,
  /async runLearningWorker[\s\S]*?await requireActiveCapability\(capabilityId\);[\s\S]*?const releaseLearningWorker = !dryRun && \(willSyncApprovedSources \|\| willRefreshRepositoryProfiles\)[\s\S]*?await claimCapabilityLearningWorker\(capabilityId, willRefreshRepositoryProfiles \? "grounding" : "sync"\)[\s\S]*?try \{[\s\S]*?finally \{[\s\S]*?try \{[\s\S]*?await releaseLearningWorker\?\.\(\);[\s\S]*?Lease expiry is the safety net/,
  "runLearningWorker should release the DB lease best-effort even when source sync or grounding fails",
);

assert.match(
  service,
  /async function activeCapabilityLearningWorker\(capabilityId: string\)[\s\S]*?prisma\.capabilityLearningWorkerLock\.findUnique\([\s\S]*?select: \{[\s\S]*?operation: true[\s\S]*?startedAt: true[\s\S]*?expiresAt: true[\s\S]*?if \(!lock \|\| lock\.expiresAt\.getTime\(\) <= Date\.now\(\)\) return null;[\s\S]*?operation: lock\.operation[\s\S]*?expiresAt: lock\.expiresAt\.toISOString\(\)/,
  "grounding status should expose the active, non-expired learning-worker lock so clients can disable both learning actions",
);

assert.match(
  service,
  /if \(willRefreshRepositoryProfiles && shouldRecordGroundingAttempt\(\{ dryRun, refreshRepositoryProfiles: input\.refreshRepositoryProfiles \}\)\) \{[\s\S]*?const claim = await recordLearningAttempt\([\s\S]*?if \(!claim\.claimed\) \{[\s\S]*?Repository grounding refresh is already running[\s\S]*?let sync: unknown = null;[\s\S]*?if \(willSyncApprovedSources\)/,
  "repository-profile refreshes should claim durable RUNNING state before their approved-source sync prelude starts",
);

assert.match(
  service,
  /const willRefreshRepositoryProfiles = input\.refreshRepositoryProfiles !== false;[\s\S]*?const willSyncApprovedSources = input\.syncApprovedSources !== false;[\s\S]*?if \(willRefreshRepositoryProfiles && shouldRecordGroundingAttempt\(\{ dryRun, refreshRepositoryProfiles: input\.refreshRepositoryProfiles \}\)\) \{[\s\S]*?recordLearningAttempt/,
  "dry runs and sync-only worker calls should not claim durable repository grounding refresh state",
);

console.log("capability learning single-flight contract tests passed");
