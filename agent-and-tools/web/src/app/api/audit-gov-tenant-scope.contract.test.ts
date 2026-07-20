/**
 * Contract: the audit-gov proxy scopes reads to the caller's verified tenant,
 * and refuses to invent one when it cannot.
 *
 * The resolution rules are exercised directly (they are pure); the wiring that
 * applies them is asserted against the route source, matching the house idiom
 * for code that cannot be imported without a Next request context.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readVerifiedCaller, resolveCallerTenantId, CLIENT_CONTROLLED_TENANT_HEADERS } from "./_tenant";

// ── reading IAM's verify response ────────────────────────────────────────────

// IAM's TokenUserOut. `tenant_ids` is a list, not a scalar tenant_id.
const iamUser = { id: "u-1", email: "a@b.c", display_name: "A", is_super_admin: false, tenant_ids: ["acme"] };

const caller = readVerifiedCaller(iamUser);
assert.ok(caller, "a well-formed IAM user should be readable");
assert.equal(caller!.id, "u-1");
assert.deepEqual(caller!.tenantIds, ["acme"], "tenant_ids should be read from IAM's field name");

assert.equal(readVerifiedCaller(null), null, "null is not a user");
assert.equal(readVerifiedCaller({ email: "no-id@b.c" }), null, "a user without an id is not usable");

assert.deepEqual(
  readVerifiedCaller({ id: "u", tenant_ids: ["b", "a", "b", "", "  "] })!.tenantIds,
  ["a", "b"],
  "tenant ids should be deduped, blank-stripped and stable-ordered",
);

// A user IAM verified via the /me fallback carries no tenant_ids at all.
assert.deepEqual(
  readVerifiedCaller({ id: "u-2", email: "x@y.z", is_super_admin: true })!.tenantIds,
  [],
  "a user with no tenant_ids field must yield no tenants, not a default",
);

// ── resolving the tenant to scope with ───────────────────────────────────────

// Exactly one membership and no explicit request: unambiguous.
assert.deepEqual(
  resolveCallerTenantId(readVerifiedCaller({ id: "u", tenant_ids: ["acme"] }), null),
  { ok: true, tenantId: "acme" },
  "a single-tenant caller should be scoped to that tenant",
);

// An explicit request the caller is a member of is honoured.
assert.deepEqual(
  resolveCallerTenantId(readVerifiedCaller({ id: "u", tenant_ids: ["acme", "globex"] }), "globex"),
  { ok: true, tenantId: "globex" },
  "a requested tenant the caller belongs to should be honoured",
);

// THE fail-open regression this whole change exists to prevent: no verified
// tenant must never become a default, an empty string, or the first thing lying
// around. It must stay unresolved.
const noTenant = resolveCallerTenantId(readVerifiedCaller({ id: "u", tenant_ids: [] }), null);
assert.equal(noTenant.ok, false, "a caller with no memberships must not resolve to a tenant");
assert.equal(noTenant.ok === false && noTenant.reason, "no-membership");

const noCaller = resolveCallerTenantId(null, null);
assert.equal(noCaller.ok, false, "an absent caller must not resolve to a tenant");

// A multi-tenant caller who named none is ambiguous — picking one would silently
// scope the read to the wrong tenant, which is worse than refusing.
const ambiguous = resolveCallerTenantId(readVerifiedCaller({ id: "u", tenant_ids: ["a", "b"] }), null);
assert.equal(ambiguous.ok, false, "a multi-tenant caller naming no tenant must not be guessed at");
assert.equal(ambiguous.ok === false && ambiguous.reason, "ambiguous");

// A tenant the caller does NOT belong to is a deliberate cross-tenant reach.
const forbidden = resolveCallerTenantId(readVerifiedCaller({ id: "u", tenant_ids: ["acme"] }), "globex");
assert.equal(forbidden.ok, false, "a non-member tenant request must be refused");
assert.equal(forbidden.ok === false && forbidden.reason, "forbidden");

// Blank/whitespace requests fall back to membership inference, not to "".
assert.deepEqual(
  resolveCallerTenantId(readVerifiedCaller({ id: "u", tenant_ids: ["acme"] }), "   "),
  { ok: true, tenantId: "acme" },
  "a blank requested tenant should not be treated as a tenant named ''",
);

// is_super_admin must not widen scope over this path — cross-tenant reads are a
// separately provisioned credential at audit-gov, not a user flag.
const superAdmin = resolveCallerTenantId(
  readVerifiedCaller({ id: "root", is_super_admin: true, tenant_ids: [] }),
  null,
);
assert.equal(superAdmin.ok, false, "super-admin must not bypass tenant scoping in the proxy");

const superAdminCrossTenant = resolveCallerTenantId(
  readVerifiedCaller({ id: "root", is_super_admin: true, tenant_ids: ["acme"] }),
  "globex",
);
assert.equal(superAdminCrossTenant.ok, false, "super-admin must not read a tenant it has no membership in");

// ── route wiring ─────────────────────────────────────────────────────────────

const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/audit-gov/[...path]/route.ts"), "utf8");

assert.match(
  route,
  /verifyCallerBearer\(req, "Audit Governance"\)/,
  "the audit-gov proxy should verify the caller via the identity-returning helper",
);

assert.match(
  route,
  /resolveCallerTenantId\(verified\.caller, req\.headers\.get\("x-tenant-id"\)\)/,
  "the proxy should resolve the tenant from the VERIFIED caller, checking the requested tenant against it",
);

assert.match(
  route,
  /for \(const header of CLIENT_CONTROLLED_TENANT_HEADERS\) headers\.delete\(header\)/,
  "the proxy must strip client-supplied tenant/scope headers before setting its own",
);

assert.match(
  route,
  /for \(const header of CLIENT_CONTROLLED_TENANT_HEADERS\) headers\.delete\(header\)[\s\S]*?if \(tenant\.ok\) \{[\s\S]*?headers\.set\("x-tenant-id", tenant\.tenantId\)/,
  "the resolved tenant header must be set AFTER the inbound ones are stripped",
);

assert.ok(
  CLIENT_CONTROLLED_TENANT_HEADERS.includes("x-cross-tenant-token"),
  "the cross-tenant token must be a client-controlled header the proxy strips",
);
assert.ok(
  CLIENT_CONTROLLED_TENANT_HEADERS.includes("x-tenant-scope"),
  "the cross-tenant scope header must be a client-controlled header the proxy strips",
);

// The failure branch must not set a tenant header at all.
const elseBranch = route.slice(route.indexOf("if (tenant.ok) {"));
assert.doesNotMatch(
  elseBranch.slice(elseBranch.indexOf("} else {")),
  /headers\.set\("x-tenant-id"/,
  "an unresolved tenant must send NO x-tenant-id rather than a default or empty one",
);

assert.match(
  route,
  /TENANT_FORBIDDEN[\s\S]*?status: 403/,
  "a request naming a tenant the caller does not belong to should be refused with 403",
);

// ── the identity-returning helper stays back-compatible ──────────────────────

const proxySource = fs.readFileSync(path.join(process.cwd(), "src/app/api/_proxy.ts"), "utf8");

assert.match(
  proxySource,
  /export async function requireVerifiedCallerBearer\([\s\S]*?return \(await verifyCallerBearer\(req, serviceName\)\)\.response;/,
  "requireVerifiedCallerBearer should remain a NextResponse|null wrapper so existing callers are unaffected",
);

assert.match(
  proxySource,
  /return \{ response: null, caller: readVerifiedCaller\(body\.user\) \}/,
  "the IAM verify path should surface the verified user instead of discarding it",
);

console.log("audit-gov tenant scope contract OK");
