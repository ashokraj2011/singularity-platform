import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const indexSource = readFileSync(path.resolve(process.cwd(), "src/index.ts"), "utf8");
const packageSource = readFileSync(path.resolve(process.cwd(), "package.json"), "utf8");

for (const name of [
  "JWT_SECRET",
  "MCP_BEARER_TOKEN",
  "AUDIT_GOV_SERVICE_TOKEN",
  "CONTEXT_FABRIC_SERVICE_TOKEN",
]) {
  assert.match(
    indexSource,
    new RegExp(`assertProductionSecret\\(\\{ name: "${name}", value: process\\.env\\.${name}`),
    `${name} must be guarded by production startup secret checks`,
  );
}

assert.match(
  indexSource,
  /assertProductionInvariant\(\{[\s\S]*?name: "AUTH_OPTIONAL"[\s\S]*?process\.env\.AUTH_OPTIONAL !== "true"/,
  "agent-service must reject AUTH_OPTIONAL=true in production-class environments",
);
assert.match(
  packageSource,
  /production-service-token\.contract\.test\.ts/,
  "agent-service contract suite must include production service token guard",
);

console.log("agent-service production service token contract tests passed");
