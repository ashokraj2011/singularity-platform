import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.match(
  service,
  /for \(const candidate of approvedCandidates\) \{[\s\S]*?await materializeBootstrapLearningCandidate\(capabilityId, candidate, userId\);[\s\S]*?\}/,
  "bootstrap review approvals must use the locked candidate materializer",
);
assert.match(
  service,
  /const conflictingGroups = Array\.from\(approve\)\.filter\(groupKey => reject\.has\(groupKey\)\);[\s\S]*?Bootstrap learning group\(s\) cannot be both approved and rejected/,
  "bootstrap review must reject contradictory approve/reject group input",
);
assert.match(
  service,
  /capabilityLearningCandidate\.updateMany\(\{[\s\S]*?where: \{ id: \{ in: rejectedIds \}, status: "PENDING" \}/,
  "bootstrap review rejection must not overwrite materialized or already-reviewed candidates",
);
assert.match(
  service,
  /agentTemplate\.updateMany\(\{[\s\S]*?where: \{ capabilityId, id: \{ in: activateAgentTemplateIds \}, status: \{ not: "ARCHIVED" \} \}/,
  "bootstrap review activation must not revive archived agent templates",
);
assert.match(
  service,
  /agentCapabilityBinding\.updateMany\(\{[\s\S]*?where: \{ capabilityId, agentTemplateId: \{ in: activateAgentTemplateIds \}, status: \{ not: "ARCHIVED" \} \}/,
  "bootstrap review activation must not revive archived agent bindings",
);
assert.match(
  service,
  /async function materializeBootstrapLearningCandidate[\s\S]*?prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertActiveCapabilityForWrite\(tx, capabilityId, "Cannot materialize learning for an archived capability\."\);[\s\S]*?FROM "CapabilityLearningCandidate"[\s\S]*?FOR UPDATE[\s\S]*?current\.status !== "PENDING"[\s\S]*?persistKnowledgeArtifactWithClient\(tx, capabilityId, artifactInput, \{[\s\S]*?assumeCapabilityLocked: true[\s\S]*?tx\.capabilityLearningCandidate\.update[\s\S]*?status: "MATERIALIZED"/,
  "candidate materialization must lock the active capability before the candidate row, persist artifact, and mark MATERIALIZED in one transaction",
);
assert.match(
  service,
  /async function persistKnowledgeArtifact\([\s\S]*?return prisma\.\$transaction\(\(tx\) => persistKnowledgeArtifactWithClient\(tx, capabilityId, input\)\);/,
  "knowledge artifact persistence must expose a transaction-aware implementation for review materialization",
);
assert.match(
  service,
  /async function persistKnowledgeArtifactWithClient[\s\S]*?options: \{ assumeCapabilityLocked\?: boolean; archivedMessage\?: string \} = \{\}[\s\S]*?if \(!options\.assumeCapabilityLocked\) \{[\s\S]*?await assertActiveCapabilityForWrite\(client, capabilityId, options\.archivedMessage\);[\s\S]*?async function assertActiveCapabilityForWrite[\s\S]*?SELECT status[\s\S]*?FROM "Capability"[\s\S]*?FOR UPDATE[\s\S]*?capability\.status === "ARCHIVED"[\s\S]*?throw new ForbiddenError\(message\)/,
  "all transaction-aware knowledge artifact writes should lock and reject archived capabilities unless the caller already locked the capability row",
);
assert.match(
  service,
  /if \(!materialized\) return null;[\s\S]*?await ensureKnowledgeEmbedding\(/,
  "candidate materialization should embed only after the transaction commits",
);
assert.doesNotMatch(
  service,
  /for \(const candidate of approvedCandidates\) \{[\s\S]*?this\.addKnowledge/,
  "bootstrap review must not materialize candidates through non-transactional addKnowledge",
);

console.log("capability learning materialization contract tests passed");
