import assert from "assert";
import fs from "fs";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:singularity@localhost:5432/singularity";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-min-32-chars-for-contracts";
process.env.AUTH_OPTIONAL = "true";
process.env.TENANT_ISOLATION_MODE = "strict";
process.env.IAM_SERVICE_TOKEN_TENANT_IDS = "tenant-b, tenant-a, tenant-a";

const {
  configuredTenantIdsForServiceToken,
  validateIamServiceTokenTenantScope,
} = require("./service-token") as typeof import("./service-token");

function main() {
  const source = fs.readFileSync("src/lib/iam/service-token.ts", "utf8");
  const envSource = fs.readFileSync("src/config/env.ts", "utf8");
  assert.match(source, /const SCOPES = \["read:reference-data", "write:reference-data", "publish:events"\]/);
  assert.match(envSource, /IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_SEC: boundedInt\([\s\S]*?10,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_SEC/);
  assert.match(source, /const IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_MS = env\.IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_SEC \* 1000;/);
  assert.match(source, /AbortSignal\.timeout\(IAM_SERVICE_TOKEN_BOOTSTRAP_TIMEOUT_MS\)/);
  assert.doesNotMatch(source, /AbortSignal\.timeout\(10_000\)/);
  assert.deepEqual(configuredTenantIdsForServiceToken(), ["tenant-a", "tenant-b"]);

  const matching = jwt.sign({
    sub: "service:agent-runtime",
    kind: "service",
    service_name: "agent-runtime",
    scopes: ["read:reference-data", "write:reference-data"],
    tenant_ids: ["tenant-b", "tenant-a"],
  }, "test-secret");
  assert.equal(validateIamServiceTokenTenantScope(matching), true);

  const mismatched = jwt.sign({
    sub: "service:agent-runtime",
    kind: "service",
    service_name: "agent-runtime",
    scopes: ["read:reference-data", "write:reference-data"],
    tenant_ids: ["tenant-a"],
  }, "test-secret");
  assert.equal(validateIamServiceTokenTenantScope(mismatched), false);

  console.log("agent-runtime IAM service-token contract tests passed");
}

main();
