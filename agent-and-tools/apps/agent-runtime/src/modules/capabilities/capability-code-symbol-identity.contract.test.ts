import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  capabilityCodeSymbolKey,
  normalizedCodeSymbolValue,
} from "./capability-code-symbol-identity";

assert.equal(normalizedCodeSymbolValue("  abc  "), "abc");

assert.equal(
  capabilityCodeSymbolKey({ repositoryId: " REPO-1 ", symbolHash: " A1B2 " }),
  "capability-code-symbol:repo-1:a1b2",
);

assert.equal(capabilityCodeSymbolKey({ repositoryId: "", symbolHash: "a1b2" }), null);
assert.equal(capabilityCodeSymbolKey({ repositoryId: "repo-1", symbolHash: " " }), null);

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");
assert.match(
  service,
  /async function persistCapabilityCodeSymbol[\s\S]*?if \(!symbolKey\) throw new Error\("Capability code symbol identity is incomplete\."\)[\s\S]*?return prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertActiveCapabilityForWrite\(tx, String\(input\.capabilityId \?\? ""\), "Cannot record code symbols for an archived capability\."\);[\s\S]*?pg_advisory_xact_lock\(hashtext\(\$\{symbolKey\}\)\)[\s\S]*?tx\.capabilityCodeSymbol\.findFirst[\s\S]*?tx\.capabilityCodeSymbol\.create/,
  "code symbol writes must fail closed when identity is incomplete, lock the active capability, and use the locked helper",
);

console.log("capability code symbol identity contract tests passed");
