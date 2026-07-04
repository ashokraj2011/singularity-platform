import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const source = readFileSync("src/modules/agents/agent.service.ts", "utf8");
const pkg = readFileSync("package.json", "utf8");

assert.match(
  source,
  /import \{ isProductionClassEnv \} from "@agentandtools\/shared";/,
  "agent-runtime must use the shared production-class detector for contract mint requirements",
);
assert.match(
  source,
  /function contractMintRequiredForActiveTemplate\(\): boolean \{[\s\S]*isProductionClassEnv\(env\.NODE_ENV\)[\s\S]*AGENT_CONTRACT_MINT_REQUIRED/,
  "active template contract minting must be required in production-class envs and explicitly opt-in test/dev runs",
);
assert.match(
  source,
  /const mintResult = await maybeMintContract\(result, actor\);/,
  "template updates must await contract minting instead of firing it in the background",
);
assert.match(
  source,
  /const restoredResult = await prisma\.\$transaction[\s\S]*?const mintResult = await maybeMintContract\(restoredResult, actor\);/,
  "template restores must also await contract minting when they restore an ACTIVE version",
);
assert.doesNotMatch(
  source,
  /void maybeMintContract\(result, actor\)/,
  "contract minting must not be fire-and-forget on publish",
);
assert.match(
  source,
  /CONTRACT_MINT_REQUIRED/,
  "contract mint failures must surface a stable error code",
);
assert.match(
  source,
  /data: \{ status: existing\.status \}/,
  "failed production-class activation must compensate by restoring the previous template status",
);
assert.match(
  source,
  /restoredResult\.status === "ACTIVE"[\s\S]*?CONTRACT_MINT_REQUIRED/,
  "failed production-class restore to ACTIVE must surface the same stable contract error code",
);

// [P1] mint vs pin-record separation — a transient DB error recording the
// contract pin must NOT be reported as a mint failure (that would revert the
// activation and re-mint a duplicate contract on retry).
assert.match(
  source,
  /async function recordContractPin\([\s\S]*?\): Promise<void>/,
  "a dedicated recordContractPin helper must own the version-row pin write",
);
assert.match(
  source,
  /const body = await readUpstreamJsonObject\(res, "prompt-composer contract mint"\)/,
  "maybeMintContract must parse prompt-composer responses through the shared upstream parser",
);
assert.match(
  source,
  /const contractId = stringValue\(data\.id\);[\s\S]*const bundleHash = stringValue\(data\.bundleHash\)[\s\S]*malformed contract response[\s\S]*await recordContractPin\(template, contractId, bundleHash\)/,
  "maybeMintContract must validate contract id/hash before recording the pin",
);
assert.match(
  source,
  /function recordContractPin\([\s\S]*?agentTemplateVersion\.update[\s\S]*?console\.error/,
  "recordContractPin must perform the version-row update and, on permanent failure, log loudly rather than throw",
);

assert.match(
  pkg,
  /agent-contract-mint-required\.contract\.test\.ts/,
  "agent-runtime contract suite must include the contract mint requirement test",
);

console.log("agent-runtime contract mint requirement contract passed");
