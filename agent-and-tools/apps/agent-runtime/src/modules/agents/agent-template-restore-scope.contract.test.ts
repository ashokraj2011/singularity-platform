import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/agents/agent.service.ts"), "utf8");

assert.match(service, /TEMPLATE_VERSION_SCOPE_MISMATCH/);
assert.match(service, /TEMPLATE_VERSION_LINEAGE_MISMATCH/);
assert.match(
  service,
  /restoredCapabilityId !== \(existing\.capabilityId \?\? null\)/,
  "restore must reject snapshots from another capability/common scope",
);
assert.match(
  service,
  /\(snapshot\.baseTemplateId \?\? null\) !== \(existing\.baseTemplateId \?\? null\)/,
  "restore must reject snapshots from a different derivation lineage",
);
assert.match(
  service,
  /capabilityId: existing\.capabilityId \?\? null/,
  "restore must preserve the current template capability ownership",
);
assert.match(
  service,
  /baseTemplateId: existing\.baseTemplateId \?\? null/,
  "restore must preserve the current template derivation lineage",
);
assert.match(
  service,
  /restoredStatus !== "ARCHIVED"[\s\S]*?requireActiveCapability\(restoredCapabilityId[\s\S]*?Cannot restore an agent template for an archived capability/,
  "restore must reject non-archived snapshots when the capability has been archived before the transaction starts",
);
assert.match(
  service,
  /const restoredResult = await prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?assertAgentCapabilityWritable\(tx, restoredCapabilityId[\s\S]*?Cannot restore an agent template for an archived capability/,
  "restore must lock and re-check active capability inside the restore transaction",
);
assert.match(
  service,
  /const restoredResult = await prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?snapshot\.defaultToolPolicyId[\s\S]*?restoredStatus !== "ARCHIVED"[\s\S]*?assertAgentToolPolicyReference\(tx, \{[\s\S]*?context: "restored agent template default tool policy"[\s\S]*?tx\.agentTemplate\.update/,
  "restore must validate restored default tool policy references before writing the snapshot",
);
assert.doesNotMatch(
  service,
  /capabilityId: snapshot\.capabilityId \?\? null/,
  "restore must not write snapshot capability ownership directly",
);
assert.doesNotMatch(
  service,
  /baseTemplateId: snapshot\.baseTemplateId \?\? null/,
  "restore must not write snapshot derivation lineage directly",
);

console.log("agent template restore scope contract tests passed");
