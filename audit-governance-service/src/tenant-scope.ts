/**
 * Fail-closed tenant scoping for the audit / cost query surface.
 *
 * The previous shape was `($2::text IS NULL OR tenant_id = $2)` — omit the query
 * param and you got every tenant's rows. Worse, three of the four endpoints
 * could not be scoped even by a caller who wanted to: `/cost/by-model` and
 * `/cost/summary` accepted no tenant parameter at all, and `/audit/timeline`
 * never filtered on tenant.
 *
 * That was survivable only because `llm_calls` is empty today. Once the gateway
 * emits per-user cost and prompt hashes into it, those same endpoints start
 * returning real cross-tenant data — which is why this lands BEFORE the emitter.
 *
 * The fix is structural rather than per-endpoint: scope is resolved once, in
 * middleware, and every query is written against the resolved scope instead of
 * an optional parameter. A request that names no tenant is refused, so a new
 * endpoint added to this router inherits the safe behaviour rather than the bug.
 * Cross-tenant reads need a SEPARATE credential from the general service token,
 * making "read every tenant" a provisioning decision rather than an omitted
 * query string.
 *
 * Scope is authorization, not attribution. It gates which rows a caller may
 * read. It is unrelated to the `tenant_id` a producer self-asserts when emitting
 * an event — that value is only as trustworthy as the shared ingest bearer, and
 * nothing here should be read as making it more so.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** A resolved read scope. `all` is only reachable with the cross-tenant token. */
export type TenantScope =
  | { mode: "tenant"; tenantId: string }
  | { mode: "all" };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantScope?: TenantScope;
    }
  }
}

/**
 * Distinct from AUDIT_GOV_SERVICE_TOKEN on purpose. Every service holding the
 * general token can read audit data; only a caller explicitly provisioned with
 * this one can read ACROSS tenants. Unset (the default) means cross-tenant
 * reads are refused outright — there is no way to widen scope by accident.
 */
const CROSS_TENANT_TOKEN = process.env.AUDIT_GOV_CROSS_TENANT_TOKEN ?? "";

/**
 * Rollout gate. `shadow` (the default) resolves an unscoped request to
 * cross-tenant and logs it; `enforce` refuses it.
 *
 * Shadow exists because no caller can currently supply a tenant: platform-web
 * sets no tenant header anywhere and its proxy discards the IAM user it just
 * verified, the workgraph audit client sends only a service token, and
 * bin/check-audit-governance-lifecycle.py sends none. Shipping `enforce` first
 * would 400 the audit dashboard on contact.
 *
 * The distinction from the bug this replaces is that widening is now explicit,
 * logged with the offending path, and flag-gated — rather than implicit in an
 * omitted query parameter. Read the shadow log to find the callers still to
 * migrate, then flip.
 *
 * This MUST reach `enforce` before the gateway starts emitting per-user cost
 * and prompt hashes into llm_calls; an empty table is the only reason shadow is
 * tolerable today.
 */
function enforcing(): boolean {
  return (process.env.AUDIT_GOV_REQUIRE_TENANT_SCOPE ?? "shadow").trim().toLowerCase() === "enforce";
}

function presentedToken(req: Request): string {
  const header = req.headers["x-cross-tenant-token"];
  return typeof header === "string" ? header : "";
}

/** Constant-time compare, mirroring requireServiceAuth's handling in routes-events. */
function tokenMatches(presented: string): boolean {
  if (!CROSS_TENANT_TOKEN) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(CROSS_TENANT_TOKEN, "utf8");
  if (a.length !== b.length) {
    // Compare anyway so a length mismatch costs the same as a value mismatch.
    timingSafeEqual(b, Buffer.alloc(b.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

export function resolveTenantScope(req: Request): TenantScope | { error: string; status: number } {
  const wantsAll = String(req.headers["x-tenant-scope"] ?? "").trim().toLowerCase() === "all";
  if (wantsAll) {
    if (!tokenMatches(presentedToken(req))) {
      return {
        status: 403,
        error: "cross-tenant scope requires a valid x-cross-tenant-token",
      };
    }
    return { mode: "all" };
  }

  const raw = req.headers["x-tenant-id"];
  const tenantId = typeof raw === "string" ? raw.trim() : "";
  if (!tenantId) {
    return {
      status: 400,
      error: "x-tenant-id header is required (or x-tenant-scope: all with a cross-tenant token)",
    };
  }
  return { mode: "tenant", tenantId };
}

export function requireTenantScope(req: Request, res: Response, next: NextFunction): void {
  const resolved = resolveTenantScope(req);
  if ("error" in resolved) {
    // Shadow relaxes exactly one thing: "this legacy caller didn't say which
    // tenant" (400). A rejected cross-tenant claim (403) is a deliberate request
    // for everything without the credential for it — relaxing THAT would hand
    // out the very scope it was just denied. Always refuse it.
    if (enforcing() || resolved.status !== 400) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    // Name the caller loudly enough to drive the migration. One line per
    // unscoped read is the point: this log IS the to-do list for flipping.
    // eslint-disable-next-line no-console
    console.warn(
      `[audit-gov] UNSCOPED TENANT READ (shadow) ${req.method} ${req.originalUrl} — ${resolved.error}. ` +
      `Set AUDIT_GOV_REQUIRE_TENANT_SCOPE=enforce once callers send x-tenant-id.`,
    );
    req.tenantScope = { mode: "all" };
    next();
    return;
  }
  req.tenantScope = resolved;
  next();
}

/**
 * Reads the scope the middleware resolved. Throws rather than defaulting: a
 * missing scope means the route was mounted without `requireTenantScope`, and
 * silently falling back to "all" is precisely the bug this module exists to
 * remove.
 */
export function scopeOf(req: Request): TenantScope {
  const scope = req.tenantScope;
  if (!scope) throw new Error("tenant scope missing — route is not behind requireTenantScope");
  return scope;
}

/**
 * A SQL predicate for the resolved scope, plus the params it consumes.
 *
 * `nextParamIndex` is the 1-based position the first produced param will occupy,
 * so callers keep explicit control of numbering rather than this helper guessing.
 * Cross-tenant scope yields `TRUE` and consumes nothing.
 */
export function tenantPredicate(
  scope: TenantScope,
  column: string,
  nextParamIndex: number,
): { sql: string; params: string[] } {
  if (scope.mode === "all") return { sql: "TRUE", params: [] };
  return { sql: `${column} = $${nextParamIndex}`, params: [scope.tenantId] };
}

/** The tenant a response should report back, for echo in result envelopes. */
export function scopeLabel(scope: TenantScope): string | null {
  return scope.mode === "all" ? null : scope.tenantId;
}
