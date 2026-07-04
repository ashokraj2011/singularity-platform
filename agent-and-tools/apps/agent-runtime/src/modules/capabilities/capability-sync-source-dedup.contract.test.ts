import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.match(
  service,
  /const syncedRepositoryKeys = new Set<string>\(\);[\s\S]*?const repoKey = capabilityRepositorySourceKey\(\{[\s\S]*?repoUrl: repo\.repoUrl,[\s\S]*?defaultBranch: repo\.defaultBranch,[\s\S]*?repositoryType: repo\.repositoryType,[\s\S]*?\}\);[\s\S]*?syncedRepositoryKeys\.has\(repoKey\)[\s\S]*?same URL, branch, and type[\s\S]*?syncedRepositoryKeys\.add\(repoKey\);[\s\S]*?helpers\.syncRepository/,
  "syncCapability must de-duplicate repository sync by normalized active source identity before invoking helpers",
);

assert.match(
  service,
  /const syncedKnowledgeSourceKeys = new Set<string>\(\);[\s\S]*?const sourceKey = capabilityKnowledgeSourceKey\(\{[\s\S]*?url: source\.url,[\s\S]*?artifactType: source\.artifactType,[\s\S]*?\}\);[\s\S]*?syncedKnowledgeSourceKeys\.has\(sourceKey\)[\s\S]*?same URL and artifact type[\s\S]*?syncedKnowledgeSourceKeys\.add\(sourceKey\);[\s\S]*?helpers\.syncKnowledgeSource/,
  "syncCapability must de-duplicate document/link sync by normalized active source identity before invoking helpers",
);

assert.match(
  service,
  /function isApprovedSource\(approved: Array<\{ sourceRef: string \| null; sourceType: string \| null \}>, sourceRef: string\): boolean \{[\s\S]*?normalizedSourceValue\(sourceRef\)\.toLowerCase\(\)[\s\S]*?if \(!expected\) return false;[\s\S]*?if \(!actual\) return false;[\s\S]*?actual === expected \|\| actual\.includes\(expected\) \|\| expected\.includes\(actual\)/,
  "approved-source checks should normalize refs, reject empty refs, and retain compatibility with historical contains-style sourceRef values",
);

console.log("capability sync source dedup contract tests passed");
