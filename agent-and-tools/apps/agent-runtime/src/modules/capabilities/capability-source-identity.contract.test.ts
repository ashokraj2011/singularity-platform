import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  capabilityKnowledgeSourceKey,
  capabilityRepositorySourceKey,
  normalizedKnowledgeArtifactType,
  normalizedRepositoryBranch,
  normalizedRepositoryType,
} from "./capability-source-identity";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.equal(normalizedRepositoryBranch(""), "main");
assert.equal(normalizedRepositoryType(null), "GITHUB");
assert.equal(normalizedKnowledgeArtifactType(undefined), "DOC");

assert.equal(
  capabilityRepositorySourceKey({
    capabilityId: "CAP-1",
    repoUrl: " HTTPS://github.com/acme/app ",
    defaultBranch: " Main ",
    repositoryType: " GitHub ",
  }),
  "capability-repository:cap-1:https://github.com/acme/app:main:github",
);

assert.equal(
  capabilityRepositorySourceKey({
    capabilityId: "cap-1",
    repoUrl: "https://github.com/acme/app",
  }),
  "capability-repository:cap-1:https://github.com/acme/app:main:github",
);

assert.equal(
  capabilityKnowledgeSourceKey({
    capabilityId: "CAP-1",
    url: " HTTPS://example.com/Runbook.md ",
    artifactType: " DOC ",
  }),
  "capability-knowledge-source:cap-1:https://example.com/runbook.md:doc",
);

assert.equal(capabilityRepositorySourceKey({ capabilityId: "cap-1", repoUrl: " " }), null);
assert.equal(capabilityKnowledgeSourceKey({ capabilityId: "cap-1", url: " " }), null);

assert.match(
  service,
  /async function persistCapabilityRepositorySource[\s\S]*?return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertActiveCapabilityForWrite\(tx, capabilityId\);[\s\S]*?SELECT pg_advisory_xact_lock\(hashtext\(\$\{sourceKey\}\)\)[\s\S]*?capabilityRepository\.create/,
  "repository source persistence should lock and reject archived capabilities before creating active source rows",
);
assert.match(
  service,
  /async function persistCapabilityKnowledgeSource[\s\S]*?return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertActiveCapabilityForWrite\(tx, capabilityId\);[\s\S]*?SELECT pg_advisory_xact_lock\(hashtext\(\$\{sourceKey\}\)\)[\s\S]*?capabilityKnowledgeSource\.create/,
  "knowledge source persistence should lock and reject archived capabilities before creating active source rows",
);

console.log("capability source identity contract tests passed");
