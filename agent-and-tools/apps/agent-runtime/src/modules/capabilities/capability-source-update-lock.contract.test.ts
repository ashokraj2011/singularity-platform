import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.match(
  service,
  /async updateRepositoryPoll[\s\S]*?repo\.status !== "ACTIVE"[\s\S]*?if \(!identityChanged\) \{[\s\S]*?prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertActiveCapabilityForWrite\(tx, capabilityId\);[\s\S]*?capabilityRepository\.updateMany\([\s\S]*?where: \{ id: repoId, capabilityId, status: "ACTIVE" \}[\s\S]*?const sourceKey = capabilityRepositorySourceKey\(nextIdentity\)[\s\S]*?prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertActiveCapabilityForWrite\(tx, capabilityId\);[\s\S]*?pg_advisory_xact_lock\(hashtext\(\$\{sourceKey\}\)\)[\s\S]*?assertNoActiveRepositorySourceDuplicate\(tx, nextIdentity, repoId\)[\s\S]*?capabilityRepository\.updateMany\([\s\S]*?where: \{ id: repoId, capabilityId, status: "ACTIVE" \}/,
  "repository source poll and identity updates must lock active capability, reject inactive sources, check duplicates, and only update active source rows in one transaction",
);
assert.match(
  service,
  /defaultBranch: normalizedRepositoryBranch\(input\.defaultBranch\)[\s\S]*?defaultBranch: nextIdentity\.defaultBranch/,
  "repository source identity updates must store the normalized branch used for duplicate checks",
);
assert.match(
  service,
  /async updateKnowledgeSource[\s\S]*?src\.status !== "ACTIVE"[\s\S]*?if \(!identityChanged\) \{[\s\S]*?prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertActiveCapabilityForWrite\(tx, capabilityId\);[\s\S]*?capabilityKnowledgeSource\.updateMany\([\s\S]*?where: \{ id: sourceId, capabilityId, status: "ACTIVE" \}[\s\S]*?const sourceKey = capabilityKnowledgeSourceKey\(nextIdentity\)[\s\S]*?prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertActiveCapabilityForWrite\(tx, capabilityId\);[\s\S]*?pg_advisory_xact_lock\(hashtext\(\$\{sourceKey\}\)\)[\s\S]*?assertNoActiveKnowledgeSourceDuplicate\(tx, nextIdentity, sourceId\)[\s\S]*?capabilityKnowledgeSource\.updateMany\([\s\S]*?where: \{ id: sourceId, capabilityId, status: "ACTIVE" \}/,
  "knowledge source poll and identity updates must lock active capability, reject inactive sources, check duplicates, and only update active source rows in one transaction",
);
assert.match(
  service,
  /url: normalizedSourceValue\(input\.url \?\? src\.url\)[\s\S]*?artifactType: normalizedKnowledgeArtifactType\(input\.artifactType \?\? src\.artifactType\)[\s\S]*?url: input\.url === undefined \? undefined : nextIdentity\.url[\s\S]*?artifactType: input\.artifactType === undefined \? undefined : nextIdentity\.artifactType/,
  "knowledge source identity updates must store the normalized URL and artifact type used for duplicate checks",
);
assert.doesNotMatch(
  service,
  /updateRepositoryPoll[\s\S]*?assertNoActiveRepositorySourceDuplicate\(prisma,/,
  "repository source update duplicate checks must not run outside the transaction",
);
assert.doesNotMatch(
  service,
  /updateKnowledgeSource[\s\S]*?assertNoActiveKnowledgeSourceDuplicate\(prisma,/,
  "knowledge source update duplicate checks must not run outside the transaction",
);

console.log("capability source update lock contract tests passed");
