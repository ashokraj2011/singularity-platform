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
  pkg,
  /agent-contract-mint-required\.contract\.test\.ts/,
  "agent-runtime contract suite must include the contract mint requirement test",
);

console.log("agent-runtime contract mint requirement contract passed");
