import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/executions/execution.service.ts"), "utf8");

assert.match(
  service,
  /import \{ ConflictError, ForbiddenError, NotFoundError \} from "\.\.\/\.\.\/shared\/errors"/,
  "execution service must use typed errors for invalid execution scope",
);

assert.match(
  service,
  /if \(template\.status !== "ACTIVE"\) \{[\s\S]*?throw new ConflictError\(`Agent template "\$\{template\.name\}" is \$\{template\.status\} and cannot be used for execution\.`\);/,
  "execution creation must reject inactive or archived templates",
);

assert.match(
  service,
  /async function lockExecutionTemplate[\s\S]*?FROM "AgentTemplate"[\s\S]*?WHERE id = \$\{templateId\}[\s\S]*?FOR UPDATE/,
  "execution creation must lock the template row before validating status",
);

assert.match(
  service,
  /if \(template\.capabilityId && input\.capabilityId && template\.capabilityId !== input\.capabilityId\) \{[\s\S]*?throw new ForbiddenError\("Cannot execute a capability-owned agent template for another capability\."\);/,
  "execution creation must reject capability-owned templates used under another capability",
);

assert.match(
  service,
  /async function lockExecutionBinding[\s\S]*?FROM "AgentCapabilityBinding"[\s\S]*?WHERE id = \$\{bindingId\}[\s\S]*?FOR UPDATE/,
  "execution creation must lock the binding row before validating status and scope",
);

assert.match(
  service,
  /if \(input\.agentBindingId\) \{[\s\S]*?const binding = await lockExecutionBinding\(tx, input\.agentBindingId\)[\s\S]*?if \(binding\.status !== "ACTIVE"\)[\s\S]*?binding\.agentTemplateId !== input\.agentTemplateId[\s\S]*?binding\.capabilityId !== input\.capabilityId[\s\S]*?executionCapabilityId = binding\.capabilityId;[\s\S]*?\}/,
  "execution creation must validate binding status, template match, and capability ownership",
);

assert.match(
  service,
  /import \{ assertCapabilityNotArchived \} from "\.\.\/capabilities\/capability-lifecycle";[\s\S]*?async function assertExecutionCapabilityWritable[\s\S]*?FROM "Capability"[\s\S]*?WHERE id = \$\{capabilityId\}[\s\S]*?FOR UPDATE[\s\S]*?assertCapabilityNotArchived\(capability, "Cannot create an execution for an archived capability\."\)/,
  "execution creation must lock and reject archived capabilities inside the create transaction using the shared lifecycle guard",
);

assert.match(
  service,
  /return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?const template = await lockExecutionTemplate\(tx, input\.agentTemplateId\)[\s\S]*?await assertExecutionCapabilityWritable\(tx, executionCapabilityId\)[\s\S]*?return tx\.agentExecution\.create/,
  "execution creation must validate scope and create the row in one guarded transaction",
);

assert.match(
  service,
  /capabilityId: executionCapabilityId,/,
  "execution rows must persist the validated or binding-derived capability id",
);

console.log("execution create validation contract tests passed");
