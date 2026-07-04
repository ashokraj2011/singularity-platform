import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.match(
  service,
  /import \{[\s\S]*capabilityDuplicateConflictMessage,[\s\S]*capabilityDuplicateWhere,[\s\S]*capabilityNaturalKey,[\s\S]*\} from "\.\/capability-identity"/,
  "capability service should import the duplicate where helper for unique-index race translation",
);

assert.match(
  service,
  /async create\(input:[\s\S]*?prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?lockCapabilityNaturalKey\(tx, input\)[\s\S]*?assertNoActiveCapabilityDuplicate\(tx, input\)[\s\S]*?tx\.capability\.create[\s\S]*?\}\)\.catch\(err => rethrowCapabilityIdentityConflict\(err, input\)\)/,
  "capability create should translate database unique races into friendly capability conflicts",
);

assert.match(
  service,
  /async bootstrap\(input: BootstrapInput[\s\S]*?prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?lockCapabilityNaturalKey\(tx, input\)[\s\S]*?assertNoActiveCapabilityDuplicate\(tx, input\)[\s\S]*?tx\.capability\.create[\s\S]*?\}\)\.catch\(err => rethrowCapabilityIdentityConflict\(err, input\)\)/,
  "capability bootstrap should translate database unique races into friendly capability conflicts",
);

assert.match(
  service,
  /const nextIdentity = \{[\s\S]*?name: input\.name \?\? existing\.name,[\s\S]*?appId: input\.appId !== undefined \? input\.appId : existing\.appId,[\s\S]*?capabilityType: input\.capabilityType !== undefined \? input\.capabilityType : existing\.capabilityType,[\s\S]*?\};[\s\S]*?\.catch\(err => rethrowCapabilityIdentityConflict\(err, nextIdentity, id\)\)/,
  "capability update should translate identity unique races using the resolved next identity",
);

assert.match(
  service,
  /async function rethrowCapabilityIdentityConflict\([\s\S]*?err instanceof Prisma\.PrismaClientKnownRequestError[\s\S]*?err\.code !== "P2002"[\s\S]*?const where = capabilityDuplicateWhere\(input, excludeId\)[\s\S]*?prisma\.capability\.findFirst\(\{[\s\S]*?select: \{ id: true, name: true, appId: true, capabilityType: true \}[\s\S]*?throw new ConflictError\(capabilityDuplicateConflictMessage\(existing\)\)[\s\S]*?Active capability already exists for this identity/,
  "unique-index race helper should re-query the duplicate and preserve the existing conflict message shape",
);

console.log("capability identity race contract tests passed");
