import assert from "assert";
import type { AuthUser } from "../../middleware/auth.middleware";
import {
  isPrivileged,
  canManageCapability,
  profileScopeWhere,
  layerScopeWhere,
  assertCanViewScope,
  assertCanManageScope,
} from "./prompt-authz";

const admin: AuthUser = { user_id: "u-admin", is_super_admin: true };
const service: AuthUser = { user_id: "service:cf", roles: ["service"] };
const ownerOfA: AuthUser = { user_id: "u-a", capability_ids: ["cap-A"] };
const stranger: AuthUser = { user_id: "u-x", capability_ids: ["cap-Z"] };

function throws(fn: () => void, codeOrStatus: number): void {
  try {
    fn();
  } catch (e) {
    assert.strictEqual((e as { status?: number }).status, codeOrStatus, `expected status ${codeOrStatus}`);
    return;
  }
  assert.fail("expected the guard to throw");
}

function main(): void {
  // ── isPrivileged ───────────────────────────────────────────────
  assert.ok(isPrivileged(admin), "super_admin is privileged");
  assert.ok(isPrivileged(service), "service token is privileged (internal caller)");
  assert.ok(isPrivileged({ user_id: "p", roles: ["platform-admin"] }), "platform-admin role");
  assert.ok(!isPrivileged(ownerOfA), "plain capability user is NOT privileged");
  assert.ok(!isPrivileged(undefined), "no actor is NOT privileged (fail closed)");

  // ── canManageCapability ────────────────────────────────────────
  assert.ok(canManageCapability(admin, "cap-anything"), "admin manages any capability");
  assert.ok(canManageCapability(ownerOfA, "cap-A"), "owner manages own capability");
  assert.ok(!canManageCapability(ownerOfA, "cap-B"), "owner does NOT manage other capability");
  assert.ok(canManageCapability({ user_id: "o", roles: ["capability-owner:cap-C"] }, "cap-C"), "owner role grants manage");
  assert.ok(!canManageCapability(undefined, "cap-A"), "no actor manages nothing");

  // ── list scope filters ─────────────────────────────────────────
  assert.deepStrictEqual(profileScopeWhere(admin), {}, "privileged → no profile restriction");
  assert.deepStrictEqual(layerScopeWhere(service), {}, "service → no layer restriction");
  const pw = profileScopeWhere(ownerOfA) as { OR: unknown[] };
  assert.ok(Array.isArray(pw.OR) && pw.OR.length === 3, "non-priv profile filter is a 3-branch OR");
  assert.deepStrictEqual(
    pw.OR[2],
    { ownerScopeType: "CAPABILITY", ownerScopeId: { in: ["cap-A"] } },
    "profile OR scopes capability rows to the actor's capability_ids",
  );
  const lw = layerScopeWhere(stranger) as { OR: unknown[] };
  assert.deepStrictEqual(
    lw.OR[1],
    { scopeType: "CAPABILITY", scopeId: { in: ["cap-Z"] } },
    "layer OR scopes capability rows to the actor's capability_ids",
  );

  // ── view guard (out-of-scope capability rows look like 404) ─────
  assertCanViewScope(admin, "CAPABILITY", "cap-A", "nf"); // privileged: ok
  assertCanViewScope(ownerOfA, "CAPABILITY", "cap-A", "nf"); // owns it: ok
  assertCanViewScope(ownerOfA, "PLATFORM", null, "nf"); // shared infra: ok
  throws(() => assertCanViewScope(stranger, "CAPABILITY", "cap-A", "nf"), 404); // not owner → NotFound

  // ── manage guard ───────────────────────────────────────────────
  assertCanManageScope(admin, "PLATFORM", null, "x"); // admin can manage platform/global
  assertCanManageScope(ownerOfA, "CAPABILITY", "cap-A", "x"); // owner manages own cap row
  throws(() => assertCanManageScope(ownerOfA, "CAPABILITY", "cap-B", "x"), 403); // other cap → Forbidden
  throws(() => assertCanManageScope(ownerOfA, "PLATFORM", null, "x"), 403); // global → admin only
  throws(() => assertCanManageScope(ownerOfA, null, null, "x"), 403); // unscoped → admin only
  throws(() => assertCanManageScope(ownerOfA, "CAPABILITY", null, "x"), 403); // capability w/o id → Forbidden

  console.log("prompt-authz.contract.test.ts: OK");
}

main();
