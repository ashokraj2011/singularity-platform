import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  capabilityAgentTemplateKey,
  normalizedAgentTemplateIdentityValue,
  normalizedAgentTemplateName,
} from "./capability-agent-template-identity";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.equal(normalizedAgentTemplateIdentityValue(" cap-1 "), "cap-1");
assert.equal(normalizedAgentTemplateName("  Delivery Agent  "), "Delivery Agent");

assert.equal(
  capabilityAgentTemplateKey({ capabilityId: " CAP-1 ", name: " Delivery Agent " }),
  "capability-agent-template:cap-1:delivery agent",
);

assert.equal(capabilityAgentTemplateKey({ capabilityId: "", name: "Delivery Agent" }), null);
assert.equal(capabilityAgentTemplateKey({ capabilityId: "cap-1", name: " " }), null);

assert.match(
  service,
  /async function persistCapabilityAgentTemplate[\s\S]*?return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertActiveCapabilityForWrite\(tx, capabilityId, "Cannot persist agent template for an archived capability\."\);[\s\S]*?SELECT pg_advisory_xact_lock\(hashtext\(\$\{templateKey\}\)\)[\s\S]*?AgentTemplate/,
  "capability-scoped generated agent templates should lock and reject archived capabilities before create/update",
);

assert.match(
  service,
  /async function assertActiveToolPolicyReference[\s\S]*?FROM "ToolPolicy"[\s\S]*?FOR UPDATE[\s\S]*?policy\.status !== "ACTIVE"[\s\S]*?scopeType === "CAPABILITY"[\s\S]*?scopeType === "AGENT_TEMPLATE"[\s\S]*?scopeType === "AGENT_BINDING"/,
  "tool policy references should lock policy rows and reject inactive or cross-scope policy references",
);

assert.match(
  service,
  /async function persistCapabilityAgentTemplate[\s\S]*?input\.defaultToolPolicyId[\s\S]*?assertActiveToolPolicyReference\(tx, \{[\s\S]*?context: "agent template default tool policy"/,
  "generated agent templates should validate default tool policy references before create/update",
);

console.log("capability agent template identity contract tests passed");
