import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/agents/agent.service.ts"), "utf8");

assert.match(service, /capabilityAgentTemplateKey/);
assert.match(
  service,
  /async function lockCapabilityTemplateName[\s\S]*?pg_advisory_xact_lock\(hashtext\(\$\{lockKey\}\)\)/,
  "template name writes must lock the normalized capability template identity",
);
assert.match(
  service,
  /async function assertNoActiveCapabilityTemplateNameConflict[\s\S]*?await lockCapabilityTemplateName[\s\S]*?findActiveCapabilityTemplateNameConflict/,
  "conflict checks must run after taking the advisory lock",
);
assert.match(
  service,
  /async function assertAgentCapabilityWritable[\s\S]*?SELECT status[\s\S]*?FROM "Capability"[\s\S]*?FOR UPDATE[\s\S]*?capability\.status === "ARCHIVED"/,
  "capability-scoped agent template/profile writes must lock and re-check capability lifecycle state in the write transaction",
);
assert.match(
  service,
  /async function assertAgentToolPolicyReference[\s\S]*?FROM "ToolPolicy"[\s\S]*?FOR UPDATE[\s\S]*?policy\.status !== "ACTIVE"[\s\S]*?scopeType === "CAPABILITY"[\s\S]*?scopeType === "AGENT_TEMPLATE"[\s\S]*?scopeType === "AGENT_BINDING"/,
  "agent template/profile writes must lock and validate default tool policy references",
);
assert.match(
  service,
  /return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?assertAgentCapabilityWritable\(tx, input\.capabilityId[\s\S]*?assertAgentToolPolicyReference\(tx, \{[\s\S]*?context: "agent profile default tool policy"[\s\S]*?label: "agent profile"[\s\S]*?tx\.agentTemplate\.create/,
  "profile creation must re-check active capability, policy reference, and duplicate names inside the create transaction",
);
assert.match(
  service,
  /return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?input\.capabilityId[\s\S]*?assertAgentCapabilityWritable\(tx, input\.capabilityId[\s\S]*?assertNoActiveCapabilityTemplateNameConflict[\s\S]*?assertAgentToolPolicyReference\(tx, \{[\s\S]*?context: "agent template default tool policy"[\s\S]*?tx\.agentTemplate\.create/,
  "template creation must re-check active capability, duplicate names, and policy reference inside the create transaction",
);
assert.match(
  service,
  /const derived = await prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?assertAgentCapabilityWritable\(tx, input\.capabilityId[\s\S]*?assertAgentToolPolicyReference\(tx, \{[\s\S]*?context: "derived agent template default tool policy"[\s\S]*?assertNoActiveCapabilityTemplateNameConflict[\s\S]*?tx\.agentTemplate\.create/,
  "derive must re-check active capability, inherited policy reference, and duplicate names inside the derive transaction",
);
assert.match(
  service,
  /const result = await prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?nextStatus !== "ARCHIVED"[\s\S]*?assertAgentCapabilityWritable\(tx, existing\.capabilityId[\s\S]*?assertNoActiveCapabilityTemplateNameConflict[\s\S]*?data\.defaultToolPolicyId !== undefined[\s\S]*?assertAgentToolPolicyReference\(tx, \{[\s\S]*?context: "agent template default tool policy"[\s\S]*?tx\.agentTemplate\.update/,
  "rename/status update must re-check active capability, duplicate names, and updated policy reference inside the update transaction",
);
assert.match(
  service,
  /const restoredResult = await prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?restoredStatus !== "ARCHIVED"[\s\S]*?assertAgentCapabilityWritable\(tx, restoredCapabilityId[\s\S]*?assertNoActiveCapabilityTemplateNameConflict[\s\S]*?tx\.agentTemplate\.update/,
  "restore must re-check active capability and duplicate names inside the restore transaction",
);

console.log("agent template name lock contract tests passed");
