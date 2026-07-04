import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/agents/agent.service.ts"), "utf8");

assert.match(service, /import \{[\s\S]*agentSkillKey[\s\S]*\} from "\.\/agent-skill-identity"/);
assert.match(
  service,
  /async function persistAgentSkill[\s\S]*?pg_advisory_xact_lock\(hashtext\(\$\{skillKey\}\)\)[\s\S]*?"AgentSkill"[\s\S]*?client\.agentSkill\.create/,
  "AgentSkill persistence must lock normalized identity and reuse active rows before creating",
);
assert.match(
  service,
  /skill = await persistAgentSkill\(tx,\s*\{/,
  "profile-created source skills must use idempotent AgentSkill persistence",
);
assert.match(
  service,
  /return prisma\.\$transaction\(\(tx\) => persistAgentSkill\(tx, input\)\)/,
  "explicit local tool creation must use idempotent AgentSkill persistence",
);
assert.match(
  service,
  /where: \{ status: "ACTIVE" \}[\s\S]*orderBy: \[\{ name: "asc" \}, \{ skillType: "asc" \}\]/,
  "local skill listing should expose active skills in stable order",
);

console.log("agent skill persistence contract tests passed");
