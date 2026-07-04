import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/agents/agent.service.ts"), "utf8");
const schema = fs.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");

assert.match(service, /import \{[\s\S]*agentTemplateSkillKey[\s\S]*\} from "\.\/agent-template-skill-identity"/);
assert.match(
  service,
  /async function persistAgentTemplateSkill[\s\S]*?pg_advisory_xact_lock\(hashtext\(\$\{linkKey\}\)\)[\s\S]*?"AgentTemplateSkill"[\s\S]*?lower\(coalesce\(nullif\(btrim\("sourceRef"\), ''\), ''\)\)[\s\S]*?lower\(coalesce\(nullif\(btrim\("capabilityId"\), ''\), ''\)\)[\s\S]*?client\.agentTemplateSkill\.create/,
  "AgentTemplateSkill persistence must lock and reuse normalized template+skill+source identity before creating",
);
assert.match(
  service,
  /metadata = \{[\s\S]*?objectValue\(existing\?\.metadata\)[\s\S]*?objectValue\(input\.metadata\)[\s\S]*?\}/,
  "AgentTemplateSkill persistence must merge existing and incoming metadata",
);
assert.match(
  service,
  /const link = await persistAgentTemplateSkill\(tx,\s*\{/,
  "profile creation must use source-aware AgentTemplateSkill persistence",
);
assert.match(
  service,
  /return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?assertAgentCapabilityWritable\(tx, template\.capabilityId[\s\S]*?return persistAgentTemplateSkill\(tx,\s*\{[\s\S]*sourceType: "local"/,
  "manual skill attachment must lock the capability and use source-aware AgentTemplateSkill persistence",
);
assert.doesNotMatch(
  service,
  /agentTemplateSkill\.upsert\(/,
  "AgentTemplateSkill writes must not use the old template+skill upsert identity",
);
assert.doesNotMatch(
  schema,
  /@@unique\(\[agentTemplateId,\s*skillId\]\)/,
  "Prisma schema must not advertise the old broad AgentTemplateSkill uniqueness rule",
);

console.log("agent template skill persistence contract tests passed");
