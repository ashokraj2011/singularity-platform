import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deriveCapabilityGroundingState, shouldRecordGroundingAttempt } from "./capability-grounding-status";

const capabilityService = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

const documentOnly = deriveCapabilityGroundingState({
  sourceState: {
    activeSourceCount: 1,
    activeRepositoryCount: 0,
    activeKnowledgeSourceCount: 1,
    sourceFingerprint: "docs-only",
  },
  storedStack: [],
  worldModelStack: [],
});

assert.equal(documentOnly.status, "NOT_CONFIGURED");
assert.equal(documentOnly.sourceDrifted, false);
assert.match(documentOnly.message, /Document\/link knowledge is configured/i);
assert.match(documentOnly.message, /repository source/i);

const driftedLearnedSources = deriveCapabilityGroundingState({
  stored: {
    status: "LEARNED",
    message: "Repository profile learned successfully.",
    lastSuccessAt: new Date("2026-07-02T00:00:00.000Z"),
    sourceFingerprint: "old-fingerprint",
  },
  sourceState: {
    activeSourceCount: 2,
    activeRepositoryCount: 1,
    activeKnowledgeSourceCount: 1,
    sourceFingerprint: "new-fingerprint",
  },
  storedStack: ["TypeScript"],
  worldModelStack: [],
});

assert.equal(driftedLearnedSources.status, "STALE");
assert.equal(driftedLearnedSources.sourceDrifted, true);
assert.match(driftedLearnedSources.message, /sources changed/i);

const blockedWithLastGoodStack = deriveCapabilityGroundingState({
  stored: {
    status: "BLOCKED",
    message: "Repository refresh failed.",
    sourceFingerprint: "same-fingerprint",
  },
  sourceState: {
    activeSourceCount: 1,
    activeRepositoryCount: 1,
    activeKnowledgeSourceCount: 0,
    sourceFingerprint: "same-fingerprint",
  },
  storedStack: ["Java", "Maven"],
  worldModelStack: [],
});

assert.equal(blockedWithLastGoodStack.status, "STALE");
assert.equal(blockedWithLastGoodStack.sourceDrifted, false);

const archived = deriveCapabilityGroundingState({
  stored: {
    status: "ARCHIVED",
    sourceFingerprint: "archived-fingerprint",
  },
  sourceState: {
    activeSourceCount: 0,
    activeRepositoryCount: 0,
    activeKnowledgeSourceCount: 0,
    sourceFingerprint: "archived-fingerprint",
  },
  storedStack: ["Java"],
  worldModelStack: [],
});

assert.equal(archived.status, "ARCHIVED");
assert.equal(archived.sourceDrifted, false);
assert.match(archived.message, /archived/i);

assert.match(
  capabilityService,
  /if \(capability\.status === "ARCHIVED"\) \{[\s\S]*?status: "ARCHIVED"[\s\S]*?preciseState: "ARCHIVED"[\s\S]*?fixCommand: null/,
  "grounding status endpoint should render archived capabilities as read-only and not refreshable",
);

assert.match(
  capabilityService,
  /const \[capability, sourceState, activeLearningWorker\] = await Promise\.all\([\s\S]*?activeCapabilityLearningWorker\(capabilityId\)[\s\S]*?status: "ARCHIVED"[\s\S]*?activeLearningWorker[\s\S]*?status: derived\.status[\s\S]*?activeLearningWorker/,
  "grounding status endpoint should include active learning-worker lock metadata for archived and active capabilities",
);

assert.match(
  capabilityService,
  /function learningStatusIsStaleRunning\([\s\S]*?String\(stored\?\.status \?\? ""\)\.toUpperCase\(\) !== "RUNNING"[\s\S]*?if \(activeLearningWorker\) return false;[\s\S]*?Date\.now\(\) - attemptAt > Math\.max\(CAPABILITY_LEARNING_RUN_STALE_MS, 60_000\)/,
  "grounding status should only treat RUNNING as active when a worker lock exists or the attempt is still inside the stale window",
);

assert.match(
  capabilityService,
  /const staleRunningWorker = learningStatusIsStaleRunning\(stored, activeLearningWorker\);[\s\S]*?const effectiveStored = staleRunningWorker && stored[\s\S]*?status: "BLOCKED"[\s\S]*?lease expired[\s\S]*?stored: effectiveStored[\s\S]*?lastFailureCode: staleRunningWorker \? "LEARNING_WORKER_STALE"[\s\S]*?staleRunningWorker: true/,
  "expired RUNNING status without an active lock should degrade to a retryable blocked or stale state instead of spinning forever",
);

assert.equal(
  shouldRecordGroundingAttempt({ refreshRepositoryProfiles: false }),
  false,
  "sync-only learning worker runs must not mutate durable grounding status",
);
assert.equal(
  shouldRecordGroundingAttempt({ refreshRepositoryProfiles: true }),
  true,
  "repository-profile refreshes should stamp a grounding attempt",
);
assert.equal(
  shouldRecordGroundingAttempt({ dryRun: true, refreshRepositoryProfiles: true }),
  false,
  "dry runs must not mutate durable grounding status",
);

console.log("capability grounding status contract tests passed");
