import assert from "node:assert/strict";
import {
  capabilityLearningCandidateKey,
  learningCandidateContentHash,
  normalizedLearningCandidateIdentityValue,
} from "./capability-learning-candidate-identity";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.equal(normalizedLearningCandidateIdentityValue(" docs/README.md "), "docs/README.md");
assert.equal(learningCandidateContentHash("same"), learningCandidateContentHash("same"));
assert.notEqual(learningCandidateContentHash("same"), learningCandidateContentHash("changed"));

const keyA = capabilityLearningCandidateKey({
  capabilityId: " CAP-1 ",
  groupKey: " Capability_Overview ",
  artifactType: " RUNBOOK ",
  title: " Build Guide ",
  content: "npm test",
  sourceType: " GITHUB_REPO ",
  sourceRef: " HTTPS://github.com/acme/app ",
});
const keyB = capabilityLearningCandidateKey({
  capabilityId: "cap-1",
  groupKey: "capability_overview",
  artifactType: "runbook",
  title: "build guide",
  content: "npm test",
  sourceType: "github_repo",
  sourceRef: "https://github.com/acme/app",
});

assert.equal(keyA, keyB);
assert.equal(
  keyA,
  `capability-learning-candidate:cap-1:capability_overview:runbook:build guide:github_repo:https://github.com/acme/app:${learningCandidateContentHash("npm test")}`,
);

assert.equal(capabilityLearningCandidateKey({
  capabilityId: "",
  groupKey: "overview",
  artifactType: "DOC",
  title: "Overview",
  content: "content",
}), null);
assert.equal(capabilityLearningCandidateKey({
  capabilityId: "cap-1",
  groupKey: "overview",
  artifactType: "DOC",
  title: "Overview",
  content: "   ",
}), null);

assert.match(
  service,
  /async function persistCapabilityLearningCandidate[\s\S]*?return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertActiveCapabilityForWrite\(tx, capabilityId, "Cannot record learning candidate for an archived capability\."\);[\s\S]*?SELECT pg_advisory_xact_lock\(hashtext\(\$\{candidateKey\}\)\)[\s\S]*?CapabilityLearningCandidate/,
  "learning candidate persistence should lock and reject archived capabilities before writing pending discovery rows",
);

console.log("capability learning candidate identity contract tests passed");
