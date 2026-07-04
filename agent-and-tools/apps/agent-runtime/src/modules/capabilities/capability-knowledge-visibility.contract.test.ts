import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const controller = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.controller.ts"), "utf8");
const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.match(
  service,
  /knowledgeArtifacts: \{ where: \{ status: "ACTIVE" \}, orderBy: \{ createdAt: "desc" \} \}/,
  "capability detail reads must not expose archived knowledge artifacts by default",
);

assert.match(
  service,
  /async listKnowledge\(capabilityId: string, input: \{ includeArchived\?: boolean \} = \{\}\)[\s\S]*?where: input\.includeArchived \? \{ capabilityId \} : \{ capabilityId, status: "ACTIVE" \}/,
  "knowledge artifact list must default to active artifacts while preserving explicit archived inspection",
);

assert.match(
  controller,
  /const includeArchived = String\(req\.query\.includeArchived \?\? ""\)\.toLowerCase\(\) === "true";[\s\S]*?capabilityService\.listKnowledge\(req\.params\.id, \{ includeArchived \}\)/,
  "knowledge artifact controller must require includeArchived=true before returning archived rows",
);

console.log("capability knowledge visibility contract tests passed");
