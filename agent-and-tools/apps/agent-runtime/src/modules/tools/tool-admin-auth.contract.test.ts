import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/tools/tool.service.ts"), "utf8");
const controller = fs.readFileSync(path.join(process.cwd(), "src/modules/tools/tool.controller.ts"), "utf8");
const routes = fs.readFileSync(path.join(process.cwd(), "src/modules/tools/tool.routes.ts"), "utf8");

assert.match(
  service,
  /import type \{ AuthUser \} from "\.\.\/\.\.\/middleware\/auth\.middleware";/,
  "tool write authorization should use the same authenticated user shape as runtime routes",
);

assert.match(
  service,
  /import \{ requirePlatformAdmin \} from "\.\.\/\.\.\/lib\/authz\/platform-admin";/,
  "tool write authorization should use the shared platform-admin helper",
);

assert.doesNotMatch(
  service,
  /function isToolPlatformAdmin|function requireToolPlatformAdmin|roles\.includes\("platform-admin"\)/,
  "tool service should not duplicate platform-admin role parsing locally",
);

for (const [method, action] of [
  ["register", "Registering a tool"],
  ["createContract", "Creating a tool contract"],
  ["createPolicy", "Creating a tool policy"],
  ["createGrant", "Creating a tool grant"],
  ["updatePolicy", "Updating a tool policy"],
  ["deletePolicy", "Archiving a tool policy"],
  ["updateGrant", "Updating a tool grant"],
  ["deleteGrant", "Archiving a tool grant"],
] as const) {
  assert.match(
    service,
    new RegExp(`async ${method}\\([\\s\\S]*?actor\\?: AuthUser[\\s\\S]*?requirePlatformAdmin\\(actor, "${action}"\\)`),
    `${method} should require platform admin before mutating tool governance state`,
  );
}

assert.match(
  controller,
  /toolService\.register\(req\.body, req\.user\)/,
  "tool registration should pass the authenticated actor to the service guard",
);

assert.match(
  controller,
  /toolService\.createContract\(req\.params\.id, req\.body, req\.user\)/,
  "tool contract creation should pass the authenticated actor to the service guard",
);

assert.match(
  controller,
  /toolService\.createPolicy\(req\.body, req\.user\)/,
  "tool policy creation should pass the authenticated actor to the service guard",
);

assert.match(
  controller,
  /toolService\.createGrant\(req\.body, req\.user\)/,
  "tool grant creation should pass the authenticated actor to the service guard",
);

assert.match(
  controller,
  /toolService\.updatePolicy\(req\.params\.id, req\.body, req\.user\)/,
  "tool policy updates should pass the authenticated actor to the service guard",
);

assert.match(
  controller,
  /toolService\.deletePolicy\(req\.params\.id, req\.user\)/,
  "tool policy archival should pass the authenticated actor to the service guard",
);

assert.match(
  controller,
  /toolService\.updateGrant\(req\.params\.id, req\.body, req\.user\)/,
  "tool grant updates should pass the authenticated actor to the service guard",
);

assert.match(
  controller,
  /toolService\.deleteGrant\(req\.params\.id, req\.user\)/,
  "tool grant archival should pass the authenticated actor to the service guard",
);

assert.match(
  routes,
  /toolRoutes\.use\(requireAuth\);/,
  "tool routes should still require authentication before controller access",
);

assert.match(
  routes,
  /toolRoutes\.post\("\/validate-call", validate\(validateCallSchema\), toolController\.validateCall\);/,
  "runtime tool-call validation should stay authenticated but not be platform-admin gated",
);

console.log("tool admin auth contract tests passed");
