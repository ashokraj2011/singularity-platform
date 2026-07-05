import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/tools/tool.service.ts"), "utf8");
const validation = fs.readFileSync(path.join(process.cwd(), "src/modules/tools/tool-validation.service.ts"), "utf8");

assert.match(
  service,
  /import \{ assertCapabilityNotArchived \} from "\.\.\/capabilities\/capability-lifecycle"/,
  "tool grant writes should use the shared capability archive guard",
);

assert.match(
  service,
  /async function assertActiveToolForWrite[\s\S]*?FROM "ToolDefinition"[\s\S]*?WHERE id = \$\{toolId\}[\s\S]*?FOR UPDATE[\s\S]*?tool\.status !== "ACTIVE"/,
  "tool contract/grant writes must lock and require an active tool",
);

assert.match(
  service,
  /async function assertActiveToolPolicyForGrant[\s\S]*?FROM "ToolPolicy"[\s\S]*?WHERE id = \$\{toolPolicyId\}[\s\S]*?FOR UPDATE[\s\S]*?policy\.status !== "ACTIVE"/,
  "tool grant creation must lock and require an active tool policy",
);

assert.match(
  service,
  /async function assertActiveCapabilityForGrant[\s\S]*?FROM "Capability"[\s\S]*?WHERE id = \$\{capabilityId\}[\s\S]*?FOR UPDATE[\s\S]*?assertCapabilityNotArchived\(capability[\s\S]*?capability\.status !== "ACTIVE"/,
  "tool grant creation must lock capability scopes and reject archived/inactive capability state",
);

assert.match(
  service,
  /async function lockToolContractVersionSequence[\s\S]*?pg_advisory_xact_lock\(hashtext\(\$\{`tool-contract:\$\{toolId\}`\}\)\)/,
  "tool contract version allocation must serialize per tool",
);

assert.match(
  service,
  /async createContract[\s\S]*?return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?assertActiveToolForWrite\(tx, toolId, "receive contracts"\)[\s\S]*?lockToolContractVersionSequence\(tx, toolId\)[\s\S]*?const last = await tx\.toolContract\.findFirst[\s\S]*?version: \(last\?\.version \?\? 0\) \+ 1/,
  "tool contract creation must validate active tool and allocate the next version inside a serialized transaction",
);

assert.match(
  service,
  /const LIFECYCLE_SCOPED_TOOL_POLICY_TYPES = new Set<string>\(\["AGENT_TEMPLATE", "AGENT_BINDING", "CAPABILITY"\]\)/,
  "tool policies with lifecycle-owned scopes should be recognized explicitly",
);

assert.match(
  service,
  /async createPolicy[\s\S]*?const scopeType = normalizedToolPolicyScopeType\(input\.scopeType\)[\s\S]*?return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?LIFECYCLE_SCOPED_TOOL_POLICY_TYPES\.has\(scopeType\)[\s\S]*?if \(!input\.scopeId\) throw new ConflictError\("Scoped tool policy requires a scopeId\."\)[\s\S]*?assertGrantScopeWritable\(tx, \{ grantScopeType: scopeType, grantScopeId: input\.scopeId \}\)[\s\S]*?return tx\.toolPolicy\.create/,
  "tool policy creation must validate lifecycle-owned scope targets inside the create transaction",
);

assert.match(
  service,
  /case "AGENT_TEMPLATE"[\s\S]*?FROM "AgentTemplate"[\s\S]*?FOR UPDATE[\s\S]*?template\.status === "ARCHIVED"[\s\S]*?template\.capabilityId[\s\S]*?assertActiveCapabilityForGrant/,
  "template-scoped grants must lock the template and reject archived template/capability state",
);

assert.match(
  service,
  /case "AGENT_BINDING"[\s\S]*?FROM "AgentCapabilityBinding"[\s\S]*?FOR UPDATE[\s\S]*?binding\.status !== "ACTIVE"[\s\S]*?assertActiveCapabilityForGrant\(client, binding\.capabilityId/,
  "binding-scoped grants must lock the binding and reject inactive binding/capability state",
);

assert.match(
  service,
  /return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?assertActiveToolForWrite\(tx, input\.toolId, "receive grants"\)[\s\S]*?assertActiveToolPolicyForGrant\(tx, input\.toolPolicyId\)[\s\S]*?assertGrantScopeWritable\(tx, input\)[\s\S]*?return tx\.toolGrant\.create/,
  "tool grant creation must validate all mutable grant targets inside the insert transaction",
);

assert.match(
  validation,
  /const scopeResolution = await resolveRuntimeGrantScopes\(input\);[\s\S]*?where: \{[\s\S]*?toolId: tool\.id,[\s\S]*?status: "ACTIVE",[\s\S]*?toolPolicy: \{ status: "ACTIVE" \},[\s\S]*?OR: scopeResolution\.filters as never,[\s\S]*?\}/,
  "runtime validation must resolve live active scopes and active policies before reading matching grants",
);

assert.match(
  validation,
  /async function resolveRuntimeGrantScopes[\s\S]*?agentTemplate\.findUnique[\s\S]*?template\.status !== "ACTIVE"[\s\S]*?agentCapabilityBinding\.findUnique[\s\S]*?binding\.status !== "ACTIVE"[\s\S]*?capabilityIsActive\(input\.capabilityId\)/,
  "runtime validation must reject inactive template, binding, and capability scopes before authorizing tool calls",
);

assert.match(
  validation,
  /async function capabilityIsActive[\s\S]*?capability\.findUnique[\s\S]*?capability\.status !== "ACTIVE"[\s\S]*?cannot authorize tool calls/,
  "runtime validation must fail closed when a capability is missing, archived, draft, or inactive",
);

console.log("tool grant scope contract tests passed");
