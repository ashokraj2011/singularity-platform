import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ForbiddenError } from "../../shared/errors";
import {
  canManageCapability,
  isPlatformAdmin,
  requireCapabilityOwner,
  requirePlatformAdmin,
  rolesOf,
} from "./platform-admin";

const agentService = fs.readFileSync(path.join(process.cwd(), "src/modules/agents/agent.service.ts"), "utf8");
const agentController = fs.readFileSync(path.join(process.cwd(), "src/modules/agents/agent.controller.ts"), "utf8");
const toolService = fs.readFileSync(path.join(process.cwd(), "src/modules/tools/tool.service.ts"), "utf8");

assert.deepEqual(rolesOf({ user_id: "u1", roles: [" Platform-Admin ", "", "OWNER:CAP-1"] }), ["platform-admin", "owner:cap-1"]);
assert.equal(isPlatformAdmin({ user_id: "u1", is_platform_admin: true }), true);
assert.equal(isPlatformAdmin({ user_id: "u1", is_super_admin: true }), true);
assert.equal(isPlatformAdmin({ user_id: "u1", roles: ["Super-Admin"] }), true);
assert.equal(isPlatformAdmin({ user_id: "u1", roles: ["developer"] }), false);

assert.equal(canManageCapability({ user_id: "u1", capability_ids: ["CAP-1"] }, "cap-1"), true);
assert.equal(canManageCapability({ user_id: "u1", roles: ["capability-owner:CAP-2"] }, "cap-2"), true);
assert.equal(canManageCapability({ user_id: "u1", roles: ["owner:CAP-3"] }, "cap-3"), true);
assert.equal(canManageCapability({ user_id: "u1", roles: ["owner:cap-4"] }, "cap-5"), false);

assert.doesNotThrow(() => requirePlatformAdmin({ user_id: "u1", roles: ["platform-admin"] }, "Testing"));
assert.throws(
  () => requirePlatformAdmin({ user_id: "u1", roles: ["developer"] }, "Testing"),
  (err) => err instanceof ForbiddenError && err.message === "Testing requires platform admin access",
);
assert.doesNotThrow(() => requireCapabilityOwner({ user_id: "u1", capability_ids: ["cap-1"] }, "cap-1", "Testing"));
assert.throws(
  () => requireCapabilityOwner({ user_id: "u1", capability_ids: [] }, "cap-1", "Testing"),
  (err) => err instanceof ForbiddenError && err.message === "Testing requires ownership of capability cap-1",
);

for (const [label, source] of [
  ["agent service", agentService],
  ["agent controller", agentController],
  ["tool service", toolService],
] as const) {
  assert.doesNotMatch(
    source,
    /function rolesOf\(actor: AuthUser \| undefined\)|function isToolPlatformAdmin|function requireToolPlatformAdmin/,
    `${label} should use the shared platform-admin helper instead of local role parsing`,
  );
}

assert.match(
  agentService,
  /import \{ isPlatformAdmin, requireCapabilityOwner, requirePlatformAdmin \} from "\.\.\/\.\.\/lib\/authz\/platform-admin";/,
  "agent service should use the shared platform-admin authorization helper",
);

assert.match(
  agentController,
  /import \{ canManageCapability, isPlatformAdmin \} from "\.\.\/\.\.\/lib\/authz\/platform-admin";/,
  "agent controller UI shaping should use the shared platform-admin authorization helper",
);

assert.match(
  toolService,
  /import \{ requirePlatformAdmin \} from "\.\.\/\.\.\/lib\/authz\/platform-admin";/,
  "tool service should use the shared platform-admin authorization helper",
);

console.log("platform-admin authz contract tests passed");
