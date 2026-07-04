import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/memory/memory.service.ts"), "utf8");

assert.match(
  service,
  /import \{ ConflictError, ForbiddenError, NotFoundError \} from "\.\.\/\.\.\/shared\/errors"/,
  "memory service should use explicit conflict/forbidden errors for invalid write scope",
);

assert.match(
  service,
  /return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?const capabilityId = await validateExecutionMemoryScope\(tx, input\.capabilityId, input\.agentBindingId\)[\s\S]*?return tx\.workflowExecutionMemory\.create/,
  "execution memory writes should normalize capabilityId through the binding scope validator inside the create transaction",
);

assert.match(
  service,
  /async function assertMemoryCapabilityWritable[\s\S]*?FROM "Capability"[\s\S]*?FOR UPDATE[\s\S]*?assertCapabilityNotArchived\(capability, archivedMessage\)/,
  "memory writes should lock the capability row and use the shared archived-state guard",
);

assert.match(
  service,
  /async function validateExecutionMemoryScope[\s\S]*?lockMemoryBinding\(client, agentBindingId\)[\s\S]*?binding\.status !== "ACTIVE"[\s\S]*?binding\.capabilityId !== capabilityId[\s\S]*?assertMemoryCapabilityWritable\(client, resolvedCapabilityId, "Cannot store execution memory for an archived capability\."\)/,
  "execution memory scope validation should reject inactive/cross-capability bindings and archived capabilities under lock",
);

assert.match(
  service,
  /async review\(id: string[\s\S]*?return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?const mem = await lockExecutionMemory\(tx, id\)[\s\S]*?resolveWritableExecutionMemoryCapability\([\s\S]*?Cannot review execution memory for an archived capability\.[\s\S]*?tx\.workflowExecutionMemory\.update/,
  "execution memory review should lock the memory row and reject archived capability scope",
);

assert.match(
  service,
  /const scopeType = input\.scopeType\.trim\(\)\.toUpperCase\(\)[\s\S]*?return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?validateDistilledMemoryPromotionScope\(tx, \{ \.\.\.input, scopeType \}\)[\s\S]*?tx\.distilledMemory\.create/,
  "distilled memory promotion should normalize scope type and validate scope inside the promote transaction",
);

assert.match(
  service,
  /async function validateDistilledMemoryPromotionScope[\s\S]*?input\.scopeType !== "CAPABILITY"[\s\S]*?assertMemoryCapabilityWritable\(client, input\.scopeId, "Cannot promote distilled memory for an archived capability\."\)[\s\S]*?FROM "WorkflowExecutionMemory"[\s\S]*?FOR UPDATE[\s\S]*?sources\.length !== new Set\(input\.sourceMemoryIds\)\.size[\s\S]*?Cannot promote execution memory from another capability/,
  "capability-scoped distilled memory promotion should lock the capability and source memories before validating ownership",
);

assert.match(
  service,
  /FROM "AgentCapabilityBinding"[\s\S]*?FOR UPDATE[\s\S]*?binding\.status !== "ACTIVE"[\s\S]*?Cannot promote memory from an inactive agent capability binding[\s\S]*?binding\.capabilityId !== input\.scopeId/,
  "distilled memory promotion should reject inactive or cross-capability source bindings",
);

assert.match(
  service,
  /async function resolveWritableExecutionMemoryCapability[\s\S]*?lockMemoryBinding\(client, memory\.agentBindingId\)[\s\S]*?Cannot mutate memory from an inactive agent capability binding[\s\S]*?assertMemoryCapabilityWritable\(client, capabilityId, archivedMessage\)/,
  "legacy memories that only have a binding should resolve and guard their capability before mutation",
);

console.log("memory write scope contract tests passed");
