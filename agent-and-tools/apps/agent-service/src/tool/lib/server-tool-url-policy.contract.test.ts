import assert from "node:assert/strict";
import { serverToolUrlPolicy } from "./server-tool-url-policy";

assert.equal(
  serverToolUrlPolicy("http://agent-service:3001/api/v1/internal-tools/search_knowledge").allowed,
  true,
  "seeded internal tool endpoints should be allowed by default",
);

assert.equal(
  serverToolUrlPolicy("http://agent-service:3001/api/v1/connector-tools/send_email").allowed,
  true,
  "seeded connector tool endpoints should be allowed by default",
);

assert.equal(
  serverToolUrlPolicy("http://agent-service:3001/api/v1/admin").allowed,
  false,
  "matching origin alone must not allow unrelated paths",
);

assert.equal(
  serverToolUrlPolicy("http://agent-service:3001.evil.test/api/v1/internal-tools/search").allowed,
  false,
  "host suffix tricks must not match trusted origins",
);

assert.equal(
  serverToolUrlPolicy("http://169.254.169.254/latest/meta-data").allowed,
  false,
  "metadata endpoints must fail closed unless explicitly allowlisted",
);

assert.equal(
  serverToolUrlPolicy("http://169.254.169.254/latest/meta-data", "http://169.254.169.254").allowed,
  false,
  "metadata endpoints must stay blocked even when a bad allowlist entry is configured",
);

assert.equal(
  serverToolUrlPolicy("http://127.0.0.1:3001/api/v1/internal-tools/search_knowledge").allowed,
  true,
  "baked internal localhost tool-service endpoints should still work for bare-metal/dev",
);

assert.equal(
  serverToolUrlPolicy("http://127.0.0.1:3001/admin", "http://127.0.0.1:3001/admin").allowed,
  false,
  "loopback allowlist entries must not permit arbitrary local SSRF targets",
);

assert.equal(
  serverToolUrlPolicy("http://10.0.0.5/agent-tools/invoke", "http://10.0.0.5/agent-tools").allowed,
  false,
  "private network allowlist entries must not permit internal SSRF targets",
);

assert.equal(
  serverToolUrlPolicy("http://host.docker.internal:3001/api/v1/internal-tools/search_knowledge", "http://host.docker.internal:3001/api/v1/internal-tools").allowed,
  false,
  "Docker host aliases must not be reachable through server tool endpoint allowlists",
);

assert.equal(
  serverToolUrlPolicy("https://embedded-user@api.github.test/agent-tools/invoke", "https://api.github.test/agent-tools").allowed,
  false,
  "endpoint URLs must not carry embedded credentials",
);

assert.equal(
  serverToolUrlPolicy("https://api.github.test/agent-tools/invoke", "https://api.github.test/agent-tools").allowed,
  true,
  "operators may explicitly allow a provider invocation prefix",
);

assert.equal(
  serverToolUrlPolicy("https://api.github.test/admin", "https://api.github.test/agent-tools").allowed,
  false,
  "explicit provider allowlist entries are path scoped",
);

console.log("server tool URL policy contract tests passed");
