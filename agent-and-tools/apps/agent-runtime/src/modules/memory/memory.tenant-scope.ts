import { configuredTenantIdsForServiceToken } from "../../lib/iam/service-token";
import { ForbiddenError } from "../../shared/errors";
import type { AuthUser } from "../../middleware/auth.middleware";

/**
 * Tenant read scope for the memory list queries (listExecution / listDistilled).
 *
 * Mirrors context-fabric's `_resolve_read_tenant_scope` / `_assert_row_tenant_visible`
 * (context_api_service/app/execute.py): a no-op for a global/unscoped deploy (the
 * default single box) and a forced filter when this deployment is tenant-scoped via
 * IAM_SERVICE_TOKEN_TENANT_IDS — the same gate CF reads through
 * `configured_tenant_ids_for_service_token()`.
 *
 * The wrinkle: agent-runtime memory rows carry no `tenant_id` column (unlike CF's
 * call_log / events_store), and neither does `Capability`. So we cannot filter rows
 * by tenant directly. The tenant proxy that IS available per request is the caller's
 * capability entitlement set (`req.user.capability_ids`):
 *
 *   - WorkflowExecutionMemory rows are keyed by `capabilityId`.
 *   - DistilledMemory rows are capability-scoped (`scopeType="CAPABILITY"`,
 *     `scopeId=capabilityId`).
 *   - Under strict tenant isolation IAM only grants a principal capability_ids that
 *     live inside its own tenant(s), so confining reads to the caller's capabilities
 *     can never return another tenant's rows. Safe by construction — exactly like the
 *     CF box that can never escape its configured tenant scope, regardless of what the
 *     caller passes (or forgets to pass).
 *
 * Deliberately no platform-admin / super-admin bypass: matching CF, a tenant-scoped
 * deployment must not leak across tenants for any caller. A principal with no
 * in-scope capabilities reads nothing (deny, not leak) rather than seeing everything.
 */
export interface MemoryReadScope {
  /** When false, behave exactly as before (no capability constraint applied). */
  enforce: boolean;
  /** Allowed capability set; only meaningful when `enforce` is true. */
  capabilityIds: string[];
}

/**
 * Pure core, independent of env, so both deploy modes are unit-testable:
 * `tenantScoped` is `configuredTenantIdsForServiceToken().length > 0`.
 */
export function memoryReadScopeFor(tenantScoped: boolean, user: AuthUser | undefined): MemoryReadScope {
  if (!tenantScoped) return { enforce: false, capabilityIds: [] };
  return { enforce: true, capabilityIds: [...new Set(user?.capability_ids ?? [])] };
}

/** Env-bound wrapper used by the service: reads IAM_SERVICE_TOKEN_TENANT_IDS. */
export function resolveMemoryReadScope(user: AuthUser | undefined): MemoryReadScope {
  return memoryReadScopeFor(configuredTenantIdsForServiceToken().length > 0, user);
}

/**
 * Resolve the capability constraint a list query MUST apply, given the read scope
 * and any caller-supplied capability key (capabilityId for execution memory, scopeId
 * for distilled memory). Mirrors CF's `_resolve_read_tenant_scope(requested_tenant_id)`:
 *
 *   - default deploy (not enforcing): honour an explicit request, else no constraint.
 *   - tenant-scoped + explicit request inside scope: use it.
 *   - tenant-scoped + explicit request outside scope: 403 (never reveal cross-tenant data).
 *   - tenant-scoped + no explicit request: force-filter to the whole allowed set.
 *
 * Returns `null` when no constraint applies, or the list of allowed capability ids
 * (an empty list means "match nothing" — the safe deny for a caller with no in-scope
 * capabilities).
 */
export function resolveCapabilityFilter(scope: MemoryReadScope, requested: string | undefined): string[] | null {
  if (!scope.enforce) return requested ? [requested] : null;
  if (requested) {
    if (!scope.capabilityIds.includes(requested)) {
      throw new ForbiddenError("requested capability is outside this caller's tenant scope");
    }
    return [requested];
  }
  return scope.capabilityIds;
}

/**
 * Assert a single-capability READ is inside the caller's tenant scope. Throws
 * ForbiddenError (→ 403) when this deployment is tenant-scoped
 * (IAM_SERVICE_TOKEN_TENANT_IDS) and `capabilityId` is outside the caller's
 * `capability_ids`; a no-op for a global single-box deploy. This is the exact
 * gate the memory list reads apply (`resolveMemoryReadScope` +
 * `resolveCapabilityFilter`), lifted for the capability world-model / knowledge
 * READ routes so those can't be turned into a cross-tenant read of another
 * tenant's grounding by its capability UUID (IDOR). Every capability route sits
 * behind `requireAuth`, so `req.user` is always present here; the check only
 * *adds* the capability-scope constraint, and only when tenant-scoped.
 */
export function assertCapabilityReadScope(user: AuthUser | undefined, capabilityId: string): void {
  // Discard the returned filter (single-id read) — we only want the throw.
  resolveCapabilityFilter(resolveMemoryReadScope(user), capabilityId);
}
