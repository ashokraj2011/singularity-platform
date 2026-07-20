/**
 * Caller tenant resolution for service proxies.
 *
 * Kept free of `next/server` and `@/` imports on purpose: the resolution rules
 * below are the security boundary, so they are a pure function that a contract
 * test can exercise directly rather than assert about by regex.
 *
 * The shape this reads is IAM's, not ours. `POST /auth/verify` answers with
 * `{valid, user, reason}` where `user` is `TokenUserOut`:
 *
 *   { id, email, display_name, is_super_admin, tenant_ids: string[] }
 *
 * (singularity-iam-service/app/auth/schemas.py). `tenant_ids` is a LIST, and it
 * is copied from the JWT's `tenant_ids` claim, which local login and SSO mint
 * from the user's ACTIVE tenant memberships. There is no scalar `tenant_id` on
 * a verified user — anything that looks like one downstream is an invention.
 *
 * Because it is a list, "which tenant is this request for" is genuinely
 * ambiguous for a multi-tenant user, and the one thing this module must never
 * do is guess. Guessing wrong does not fail — it silently scopes the read to
 * the wrong tenant, which is a worse outcome than the unscoped read this whole
 * effort exists to close.
 */

/** A caller IAM has vouched for. `tenantIds` may legitimately be empty. */
export type VerifiedCaller = {
  id: string;
  email: string | null;
  tenantIds: string[];
  isSuperAdmin: boolean;
};

export type TenantResolution =
  | { ok: true; tenantId: string }
  /**
   * No tenant could be established. The caller is authenticated — this is not
   * an auth failure — but the request cannot be scoped, so it must NOT be sent
   * with a fabricated tenant. `forbidden` is the one case that is a deliberate
   * reach for another tenant rather than a gap.
   */
  | { ok: false; reason: "no-membership" | "ambiguous" | "forbidden"; message: string };

function cleanId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Normalizes an IAM user object into a VerifiedCaller.
 *
 * Reads `tenant_ids` (IAM's field) and tolerates a `tenantIds` spelling, but
 * deliberately does NOT synthesize a tenant from any other field. Returns null
 * for anything that does not identify a user.
 */
export function readVerifiedCaller(value: unknown): VerifiedCaller | null {
  if (!isRecord(value)) return null;
  const id = cleanId(value.id) || cleanId(value.user_id) || cleanId(value.sub);
  if (!id) return null;

  const rawTenantIds = Array.isArray(value.tenant_ids)
    ? value.tenant_ids
    : Array.isArray(value.tenantIds)
      ? value.tenantIds
      : [];
  // Dedupe + drop blanks. An entry of "" would otherwise resolve to a tenant
  // whose id is the empty string, which audit-gov treats as "no tenant".
  const tenantIds = [...new Set(rawTenantIds.map(cleanId).filter(Boolean))].sort();

  return {
    id,
    email: cleanId(value.email) || null,
    tenantIds,
    isSuperAdmin: value.is_super_admin === true || value.isSuperAdmin === true,
  };
}

/**
 * Decides the tenant a proxied read should be scoped to.
 *
 * `requestedTenantId` is what the browser ASKED for. It is never trusted on its
 * own — it is only honoured after being checked against the memberships IAM
 * just vouched for, which is what makes it safe to accept a tenant hint from an
 * untrusted client at all.
 *
 * Super-admin is intentionally NOT a bypass here. Reading across tenants is
 * audit-gov's `x-tenant-scope: all` + cross-tenant token, a separately
 * provisioned credential; letting an is_super_admin flag widen scope over this
 * path would route around that provisioning decision.
 */
export function resolveCallerTenantId(
  caller: VerifiedCaller | null,
  requestedTenantId?: string | null,
): TenantResolution {
  const requested = cleanId(requestedTenantId);
  const memberships = caller?.tenantIds ?? [];

  if (requested) {
    if (memberships.includes(requested)) return { ok: true, tenantId: requested };
    return {
      ok: false,
      reason: "forbidden",
      message: `caller is not a member of tenant "${requested}"`,
    };
  }

  if (memberships.length === 1) return { ok: true, tenantId: memberships[0] };

  if (memberships.length === 0) {
    return {
      ok: false,
      reason: "no-membership",
      message:
        "IAM returned no tenant_ids for this caller, so the request cannot be tenant-scoped",
    };
  }

  return {
    ok: false,
    reason: "ambiguous",
    message:
      `caller belongs to ${memberships.length} tenants (${memberships.join(", ")}); ` +
      "the request must name one via the x-tenant-id header",
  };
}

/**
 * Headers a client must never be able to set on a proxied audit request.
 *
 * `proxyHeaders` copies every non-hop-by-hop header straight through, so absent
 * this list a browser could hand audit-gov its own `x-tenant-id` — or present
 * `x-tenant-scope: all` with a guessed `x-cross-tenant-token` — and the service
 * would honour it. Scope is decided here from the verified identity, so the
 * inbound values are stripped first and set second.
 */
export const CLIENT_CONTROLLED_TENANT_HEADERS = [
  "x-tenant-id",
  "x-tenant-scope",
  "x-cross-tenant-token",
] as const;
