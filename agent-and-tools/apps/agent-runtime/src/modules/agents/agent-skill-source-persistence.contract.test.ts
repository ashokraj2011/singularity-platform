import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/agents/agent.service.ts"), "utf8");

assert.match(service, /import \{[\s\S]*agentSkillSourceKey[\s\S]*\} from "\.\/agent-skill-source-identity"/);
assert.match(
  service,
  /async function persistAgentSkillSource[\s\S]*?pg_advisory_xact_lock\(hashtext\(\$\{sourceKey\}\)\)[\s\S]*?"AgentSkillSource"[\s\S]*?client\.agentSkillSource\.create/,
  "AgentSkillSource persistence must lock normalized source identity and reuse active rows before creating",
);
assert.match(
  service,
  /metadata = \{[\s\S]*?objectValue\(existing\?\.metadata\)[\s\S]*?objectValue\(input\.metadata\)[\s\S]*?\}/,
  "AgentSkillSource persistence must merge existing and incoming metadata",
);
assert.match(
  service,
  /const source = await persistAgentSkillSource\(tx,\s*\{/,
  "profile creation must use idempotent AgentSkillSource persistence",
);
assert.doesNotMatch(
  service,
  /tx\.agentSkillSource\.create\(/,
  "profile creation must not raw-create AgentSkillSource rows",
);

console.log("agent skill source persistence contract tests passed");
