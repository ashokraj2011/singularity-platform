import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.match(
  service,
  /async deleteKnowledgeSource\(capabilityId: string, sourceId: string\)[\s\S]*?const sourceUrl = normalizedSourceValue\(src\.url\);[\s\S]*?prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertActiveCapabilityForWrite\(tx, capabilityId\);/,
  "knowledge source deletion must normalize source URL and lock the active capability inside the archive transaction",
);

assert.match(
  service,
  /UPDATE "CapabilityKnowledgeArtifact"[\s\S]*?SET status = 'ARCHIVED'[\s\S]*?WHERE "capabilityId" = \$\{capabilityId\}[\s\S]*?AND status = 'ACTIVE'[\s\S]*?lower\(btrim\("sourceRef"\)\) = lower\(\$\{sourceUrl\}\)/,
  "deleting a knowledge source must archive active artifacts backed by the same sourceRef URL",
);

assert.match(
  service,
  /tx\.capabilityKnowledgeSource\.update\(\{[\s\S]*?where: \{ id: sourceId \}[\s\S]*?data: \{ status: "ARCHIVED", pollIntervalSec: null \}/,
  "deleted knowledge sources must be archived and have polling disabled",
);

assert.match(
  service,
  /return \{ \.\.\.source, archivedArtifactCount \};/,
  "deleteKnowledgeSource should expose how many active artifacts were removed from runtime visibility",
);

console.log("capability source delete artifact archive contract tests passed");
