// [P0] Capability isolation for prompt profiles & layers.
//
// A profile/layer is "capability-private" when its scope is CAPABILITY: only
// owners of that capability (or privileged callers) may see or manage it.
// Every other scope (PLATFORM / TENANT / WORKFLOW / … or unscoped) is shared
// authoring infrastructure — readable by any authenticated caller, writable
// only by privileged callers.
//
// Privileged = platform / super admin (from a real user token) OR an internal
// service token (roles:["service"]). Service tokens are how context-fabric and
// agent-runtime call composer on the system's behalf, so they must NOT be
// capability-filtered. (is_super_admin is only ever set for user tokens — see
// auth.middleware.ts principalFromDecoded.)
//
// Mirrors agent-runtime's canManageCapability/isPlatformAdmin so the two
// services agree on what "owning a capability" means.

import type { AuthUser } from "../../middleware/auth.middleware";
import { ForbiddenError, NotFoundError } from "../../shared/errors";

const CAPABILITY = "CAPABILITY";

function lcRoles(actor?: AuthUser): string[] {
  return (actor?.roles ?? []).map((r) => r.toLowerCase());
}

export function isPrivileged(actor?: AuthUser): boolean {
  if (!actor) return false;
  if (actor.is_super_admin) return true;
  const roles = lcRoles(actor);
  return roles.includes("service") || roles.includes("platform-admin") || roles.includes("super-admin");
}

export function canManageCapability(actor: AuthUser | undefined, capabilityId: string | null | undefined): boolean {
  if (isPrivileged(actor)) return true;
  if (!capabilityId) return false;
  if (actor?.capability_ids?.includes(capabilityId)) return true;
  const roles = lcRoles(actor); // roles are lowercased, so lowercase the expected too
  const cap = capabilityId.toLowerCase();
  return roles.includes(`capability-owner:${cap}`) || roles.includes(`owner:${cap}`);
}

function viewableCapabilityIds(actor?: AuthUser): string[] {
  return actor?.capability_ids ?? [];
}

/**
 * Prisma `where` fragment restricting a PromptProfile list to what `actor` may
 * see. Returns `{}` (no restriction) for privileged callers.
 */
export function profileScopeWhere(actor?: AuthUser): Record<string, unknown> {
  if (isPrivileged(actor)) return {};
  const caps = viewableCapabilityIds(actor);
  return {
    OR: [
      { ownerScopeType: { not: CAPABILITY } }, // non-capability scopes (SQL <> excludes NULL)
      { ownerScopeType: null }, // unscoped / global
      { ownerScopeType: CAPABILITY, ownerScopeId: { in: caps } }, // my capability
    ],
  };
}

/** PromptLayer equivalent of profileScopeWhere. scopeType is non-null in schema. */
export function layerScopeWhere(actor?: AuthUser): Record<string, unknown> {
  if (isPrivileged(actor)) return {};
  const caps = viewableCapabilityIds(actor);
  return {
    OR: [
      { scopeType: { not: CAPABILITY } },
      { scopeType: CAPABILITY, scopeId: { in: caps } },
    ],
  };
}

/**
 * View guard for a single row. Throws NotFound (not Forbidden) for out-of-scope
 * capability-private rows so we don't leak their existence.
 */
export function assertCanViewScope(
  actor: AuthUser | undefined,
  scopeType: string | null | undefined,
  scopeId: string | null | undefined,
  notFoundMessage: string,
): void {
  if (isPrivileged(actor)) return;
  if (scopeType !== CAPABILITY) return; // shared infra
  if (scopeId && viewableCapabilityIds(actor).includes(scopeId)) return;
  throw new NotFoundError(notFoundMessage);
}

/**
 * Manage guard for create/update/attach. Capability-scoped → must own the
 * capability; any other scope (PLATFORM/TENANT/… or unscoped) → privileged only.
 */
export function assertCanManageScope(
  actor: AuthUser | undefined,
  scopeType: string | null | undefined,
  scopeId: string | null | undefined,
  what: string,
): void {
  if (isPrivileged(actor)) return;
  if (scopeType === CAPABILITY) {
    if (scopeId && canManageCapability(actor, scopeId)) return;
    throw new ForbiddenError(`You do not have access to manage ${what} for capability ${scopeId ?? "(unset)"}`);
  }
  throw new ForbiddenError(`Managing ${scopeType ?? "unscoped"} ${what} requires platform admin access`);
}
