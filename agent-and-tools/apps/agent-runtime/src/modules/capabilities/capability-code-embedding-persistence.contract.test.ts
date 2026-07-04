import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");
const schema = fs.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");

assert.match(service, /import \{[\s\S]*capabilityCodeEmbeddingKey[\s\S]*\} from "\.\/capability-code-embedding-identity"/);
assert.match(
  service,
  /async function ensureCodeSymbolEmbedding[\s\S]*?pg_advisory_xact_lock\(hashtext\(\$\{embeddingKey\}\)\)[\s\S]*?JOIN "Capability" c ON c\.id = s\."capabilityId"[\s\S]*?FOR UPDATE OF c[\s\S]*?"CapabilityCodeEmbedding"[\s\S]*?FOR UPDATE[\s\S]*?tx\.capabilityCodeEmbedding\.update[\s\S]*?tx\.capabilityCodeEmbedding\.create[\s\S]*?UPDATE "CapabilityCodeEmbedding" target[\s\S]*?c\.status <> 'ARCHIVED'/,
  "code symbol embedding persistence must lock symbol identity, reuse existing rows, and write vectors through one helper",
);
assert.match(
  service,
  /const embedded = await ensureCodeSymbolEmbedding\(\{[\s\S]*?symbolId: r\.symbol_id[\s\S]*?embedder/,
  "re-embed path must use ensureCodeSymbolEmbedding instead of direct CapabilityCodeEmbedding writes",
);
assert.doesNotMatch(
  service,
  /prisma\.capabilityCodeEmbedding\.create\(/,
  "CapabilityCodeEmbedding writes outside the locked helper are not allowed",
);
assert.doesNotMatch(
  service,
  /capabilityCodeEmbedding\.upsert\(/,
  "CapabilityCodeEmbedding writes must not bypass vector update handling through direct upsert",
);
assert.match(
  schema,
  /model CapabilityCodeEmbedding \{[\s\S]*@@unique\(\[symbolId\]\)/,
  "CapabilityCodeEmbedding must have a DB-backed unique symbol identity",
);

console.log("capability code embedding persistence contract tests passed");
