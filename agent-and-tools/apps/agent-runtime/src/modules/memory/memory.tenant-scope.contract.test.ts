import assert from "assert";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:singularity@localhost:5432/singularity";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-min-32-chars-for-contracts";
process.env.AUTH_OPTIONAL = "true";
// Tenant-scoped deployment: forces the read filter on. Set before importing so the
// env module (parsed once at load) picks it up — mirrors service-token.contract.test.ts.
process.env.IAM_SERVICE_TOKEN_TENANT_IDS = "tenant-a";

const {
  memoryReadScopeFor,
  resolveMemoryReadScope,
  resolveCapabilityFilter,
} = require("./memory.tenant-scope") as typeof import("./memory.tenant-scope");

import { ForbiddenError } from "../../shared/errors";
import type { AuthUser } from "../../middleware/auth.middleware";

const userWithCaps = (capability_ids: string[]): AuthUser => ({ user_id: "u1", capability_ids });

function main() {
  // ── Default single-box deploy (no configured tenants) → no-op, pure core ──
  const open = memoryReadScopeFor(false, userWithCaps(["cap-1"]));
  assert.equal(open.enforce, false);
  // Not enforcing: no explicit request → no constraint; explicit request → honoured verbatim.
  assert.equal(resolveCapabilityFilter(open, undefined), null);
  assert.deepEqual(resolveCapabilityFilter(open, "cap-anything"), ["cap-anything"]);

  // ── Tenant-scoped deploy (pure core) → forced filter ──
  const scoped = memoryReadScopeFor(true, userWithCaps(["cap-1", "cap-2", "cap-1"]));
  assert.equal(scoped.enforce, true);
  assert.deepEqual(scoped.capabilityIds, ["cap-1", "cap-2"]); // de-duped

  // No explicit request → force-filter to the whole allowed set.
  assert.deepEqual(resolveCapabilityFilter(scoped, undefined), ["cap-1", "cap-2"]);
  // Explicit request inside scope → that capability only.
  assert.deepEqual(resolveCapabilityFilter(scoped, "cap-2"), ["cap-2"]);
  // Explicit request outside scope → 403 (never reveal another tenant's rows).
  assert.throws(() => resolveCapabilityFilter(scoped, "cap-other"), ForbiddenError);

  // Caller with no in-scope capabilities → empty allowed set = match nothing (deny, not leak).
  const noCaps = memoryReadScopeFor(true, userWithCaps([]));
  assert.deepEqual(resolveCapabilityFilter(noCaps, undefined), []);
  const undefinedUser = memoryReadScopeFor(true, undefined);
  assert.deepEqual(resolveCapabilityFilter(undefinedUser, undefined), []);

  // ── Env wiring: IAM_SERVICE_TOKEN_TENANT_IDS=tenant-a flips enforce on ──
  const fromEnv = resolveMemoryReadScope(userWithCaps(["cap-1"]));
  assert.equal(fromEnv.enforce, true);
  assert.deepEqual(fromEnv.capabilityIds, ["cap-1"]);

  console.log("agent-runtime memory tenant-scope contract tests passed");
}

main();
