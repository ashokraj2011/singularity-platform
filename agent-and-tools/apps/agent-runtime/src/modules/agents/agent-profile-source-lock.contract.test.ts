import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/agents/agent.service.ts"), "utf8");

assert.match(
  service,
  /PROMPT_IMMUTABLE_SOURCE_TYPES = \["url_document", "uploaded_document"\]/,
  "URL and uploaded document sources must be the immutable source-backed profile types",
);
assert.match(
  service,
  /PROMPT_IMMUTABLE_SOURCE_SET\.has\(binding\.sourceType\)[\s\S]*?permissions = permissions\.filter\(\(p\) => p === "read"\)/,
  "source-backed document skills must be provider-locked and clamped to read-only permissions",
);
assert.match(
  service,
  /async function assertReadableSourceBackedBinding[\s\S]*?AGENT_SOURCE_URL_REQUIRED[\s\S]*?assertAgentSourceUrlAllowed\(sourceRef/,
  "URL document profile bindings must require and validate a URL before persistence",
);
assert.match(
  service,
  /const dedupedBindings = dedupeProfileSkillBindings\(bindings\);[\s\S]*?for \(const binding of dedupedBindings\) \{[\s\S]*?await assertReadableSourceBackedBinding\(binding\);/,
  "profile creation must fail before creating a template when source-backed bindings are unreadable",
);
assert.match(
  service,
  /function promptPatchChangesTemplate[\s\S]*?patch\.instructions[\s\S]*?patch\.basePromptProfileId/,
  "template updates must detect prompt-bearing field changes",
);
assert.match(
  service,
  /function snapshotPromptChangesTemplate[\s\S]*?snapshot\.instructions[\s\S]*?snapshot\.basePromptProfileId/,
  "version restore must detect prompt-bearing field changes",
);
assert.match(
  service,
  /AGENT_PROFILE_PROMPT_IMMUTABLE/,
  "source-backed profiles must reject later prompt changes with a stable error code",
);
assert.match(
  service,
  /const promptChanged = promptPatchChangesTemplate\(existing, data\);[\s\S]*?await assertPromptMutableForSourceBackedTemplate\(prisma, id\);[\s\S]*?const result = await prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertPromptMutableForSourceBackedTemplate\(tx, id\);/,
  "template updates must enforce source-backed prompt immutability before and inside the transaction",
);
assert.match(
  service,
  /const promptChanged = snapshotPromptChangesTemplate\(existing, snapshot\);[\s\S]*?await assertPromptMutableForSourceBackedTemplate\(prisma, id\);[\s\S]*?const restoredResult = await prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertPromptMutableForSourceBackedTemplate\(tx, id\);/,
  "version restore must enforce source-backed prompt immutability before and inside the transaction",
);

console.log("agent profile source lock contract tests passed");
