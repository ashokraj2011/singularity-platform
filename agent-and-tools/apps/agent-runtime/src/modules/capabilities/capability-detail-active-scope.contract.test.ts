import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.match(
  service,
  /async get\(id: string\)[\s\S]*?children: \{ where: \{ status: \{ not: "ARCHIVED" \} \} \}/,
  "capability detail should hide archived child capabilities from the active graph",
);

assert.match(
  service,
  /async get\(id: string\)[\s\S]*?repositories: \{ where: \{ status: "ACTIVE" \}, orderBy: \{ createdAt: "asc" \} \}/,
  "capability detail should only return active repositories",
);

assert.match(
  service,
  /async get\(id: string\)[\s\S]*?knowledgeArtifacts: \{ where: \{ status: "ACTIVE" \}, orderBy: \{ createdAt: "desc" \} \}/,
  "capability detail should only return active knowledge artifacts",
);

assert.match(
  service,
  /async get\(id: string\)[\s\S]*?bindings: \{[\s\S]*?where: \{[\s\S]*?status: \{ not: "ARCHIVED" \}[\s\S]*?agentTemplate: \{ status: \{ not: "ARCHIVED" \} \}[\s\S]*?include: \{ agentTemplate: true \}/,
  "capability detail should hide archived bindings and archived agent templates",
);

console.log("capability detail active scope contract tests passed");
