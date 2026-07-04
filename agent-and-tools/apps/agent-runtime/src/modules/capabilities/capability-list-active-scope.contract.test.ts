import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const controller = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.controller.ts"), "utf8");
const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");
const listIdentity = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability-list-identity.ts"), "utf8");

assert.match(
  controller,
  /const includeArchived = String\(req\.query\.includeArchived \?\? ""\)\.toLowerCase\(\) === "true"[\s\S]*?capabilityService\.list\(\{ includeArchived \}\)/,
  "capability list controller should require an explicit includeArchived=true opt-in",
);

assert.match(
  service,
  /async list\(options: \{ includeArchived\?: boolean \} = \{\}\)[\s\S]*?const rows = await prisma\.capability\.findMany\(\{[\s\S]*?where: options\.includeArchived \? undefined : \{ status: \{ not: "ARCHIVED" \} \}/,
  "capability list should exclude archived capabilities by default",
);

assert.match(
  service,
  /async list\(options: \{ includeArchived\?: boolean \} = \{\}\)[\s\S]*?children: \{ where: \{ status: \{ not: "ARCHIVED" \} \} \}[\s\S]*?repositories: \{ where: \{ status: "ACTIVE" \}, orderBy: \{ createdAt: "asc" \} \}/,
  "capability list should hide archived children and inactive repositories from summary payloads",
);

assert.match(
  service,
  /import \{ collapseCapabilityListDuplicates \} from "\.\/capability-list-identity";/,
  "capability service should import the list identity collapse helper",
);

assert.match(
  service,
  /async list\(options: \{ includeArchived\?: boolean \} = \{\}\)[\s\S]*?return collapseCapabilityListDuplicates\(rows\);/,
  "capability list should collapse duplicate capability identities before returning API rows",
);

assert.match(
  listIdentity,
  /export function collapseCapabilityListDuplicates<T extends CapabilityListIdentityRow>[\s\S]*?const grouped = new Map<string, T\[\]>\(\);[\s\S]*?const key = capabilityListIdentityBucket\(row\);[\s\S]*?duplicateCapabilityIds: duplicates\.map\(row => row\.id\),[\s\S]*?duplicateCapabilityCount: duplicates\.length,/,
  "duplicate collapse should group by stable capability identity and expose hidden duplicate ids on the canonical row",
);

assert.match(
  listIdentity,
  /export function capabilityListIdentityBucket\(row: CapabilityIdentityInput & \{ status: unknown \}\): string \| null[\s\S]*?if \(!status \|\| status === "DRAFT" \|\| status === "INACTIVE"\) return null;[\s\S]*?const key = capabilityNaturalKey\(row\);[\s\S]*?return key\.includes\("::"\) \|\| key\.endsWith\(":"\) \? null : `\$\{status\}:\$\{key\}`;/,
  "duplicate collapse should be scoped by lifecycle status so archived history is not mixed with active rows",
);

assert.match(
  listIdentity,
  /export function compareCapabilityListCanonical<T extends \{ id: string; createdAt: Date; updatedAt: Date \}>[\s\S]*?a\.createdAt\.getTime\(\) - b\.createdAt\.getTime\(\)[\s\S]*?a\.updatedAt\.getTime\(\) - b\.updatedAt\.getTime\(\)[\s\S]*?a\.id\.localeCompare\(b\.id\)/,
  "duplicate collapse should keep the deterministic earliest-created canonical capability",
);

console.log("capability list active scope contract tests passed");
