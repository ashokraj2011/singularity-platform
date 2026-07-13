import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");
const schemas = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.schemas.ts"), "utf8");
const reference = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/iam-capability-reference.ts"), "utf8");

assert.match(
  schemas,
  /createCapabilitySchema = z\.object\(\{[\s\S]*?iamCapabilityId: z\.string\(\)\.uuid\(\)/,
  "capability materialization must require the canonical IAM capability id",
);
assert.match(
  service,
  /async create\(input: \{[\s\S]*?iamCapabilityId: string[\s\S]*?\n\s*\}\, authHeader\?\: string\) \{[\s\S]*?requireIamCapabilityReference\(input\.iamCapabilityId, authHeader\)/,
  "runtime capability creation must verify IAM before writing its projection",
);
assert.match(
  service,
  /async bootstrap\(input: BootstrapInput[\s\S]*?requireIamCapabilityReference\(input\.iamCapabilityId, authHeader\)/,
  "capability bootstrap must verify IAM before materializing agents and sources",
);
assert.match(
  service,
  /async update\(id: string[\s\S]*?updateIamCapabilityReference\(id,/,
  "runtime updates must forward IAM-owned identity fields before updating local state",
);
assert.match(
  service,
  /async archive\(id: string[\s\S]*?updateIamCapabilityReference\(id, \{ status: \"archived\" \}/,
  "runtime archive must update IAM before archiving its projection",
);
assert.doesNotMatch(
  service,
  /syncIamCapabilityReference\(/,
  "runtime capability lifecycle must not create or reverse-sync IAM identities",
);
assert.match(
  reference,
  /must not create a new capability identity in IAM as a side effect/,
  "the IAM reference boundary should document read-before-materialize ownership",
);

console.log("capability IAM ownership contract tests passed");
