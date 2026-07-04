import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.match(
  service,
  /async bindAgent\(capabilityId: string,[\s\S]*?const template = await prisma\.agentTemplate\.findUnique[\s\S]*?if \(template\.status !== "ACTIVE"\) \{[\s\S]*?throw new ConflictError\(`Agent template "\$\{template\.name\}" is \$\{template\.status\} and cannot be bound as an active capability agent\.`\);[\s\S]*?if \(template\.capabilityId && template\.capabilityId !== capabilityId\) \{[\s\S]*?throw new ForbiddenError\("Cannot bind an agent template owned by another capability\."\)/,
  "manual capability binding must reject inactive/archived templates and templates owned by another capability",
);

assert.match(
  service,
  /async listBindings\(capabilityId: string\)[\s\S]*?where: \{[\s\S]*?capabilityId,[\s\S]*?status: \{ not: "ARCHIVED" \},[\s\S]*?agentTemplate: \{ status: \{ not: "ARCHIVED" \} \}/,
  "capability binding reads must hide archived bindings and archived templates by default",
);

console.log("capability agent binding ownership contract tests passed");
