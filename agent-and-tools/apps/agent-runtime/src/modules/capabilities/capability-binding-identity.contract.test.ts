import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  capabilityAgentBindingKey,
  normalizedBindingIdentityValue,
} from "./capability-binding-identity";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.equal(normalizedBindingIdentityValue(" cap-1 "), "cap-1");

assert.equal(
  capabilityAgentBindingKey({ capabilityId: " CAP-1 ", agentTemplateId: " TEMPLATE-1 " }),
  "capability-agent-binding:cap-1:template-1",
);

assert.equal(capabilityAgentBindingKey({ capabilityId: "", agentTemplateId: "template-1" }), null);
assert.equal(capabilityAgentBindingKey({ capabilityId: "cap-1", agentTemplateId: " " }), null);

assert.match(
  service,
  /async function persistAgentCapabilityBinding[\s\S]*?return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertActiveCapabilityForWrite\(tx, String\(input\.capabilityId \?\? ""\), "Cannot persist agent binding for an archived capability\."\);[\s\S]*?SELECT pg_advisory_xact_lock\(hashtext\(\$\{bindingKey\}\)\)[\s\S]*?agentCapabilityBinding/,
  "capability-scoped generated agent bindings should lock and reject archived capabilities before create/update",
);

assert.match(
  service,
  /async function assertAgentBindingPolicyReferences[\s\S]*?input\.toolPolicyId[\s\S]*?context: "agent binding tool policy"[\s\S]*?input\.memoryScopePolicyId[\s\S]*?context: "agent binding memory scope policy"/,
  "agent binding persistence should validate both tool and memory-scope policy references",
);

assert.match(
  service,
  /async function persistAgentCapabilityBinding[\s\S]*?const existing = await tx\.agentCapabilityBinding\.findFirst[\s\S]*?await assertAgentBindingPolicyReferences\(tx, input, existing\?\.id\)[\s\S]*?if \(!existing\) return tx\.agentCapabilityBinding\.create/,
  "agent binding policy references should be checked inside the binding create/update transaction",
);

console.log("capability binding identity contract tests passed");
