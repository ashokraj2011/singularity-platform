import type { AuthUser } from "../../middleware/auth.middleware";
import { ForbiddenError } from "../../shared/errors";

export function rolesOf(actor: AuthUser | undefined): string[] {
  return (actor?.roles ?? [])
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformAdmin(actor: AuthUser | undefined): boolean {
  const roles = rolesOf(actor);
  return Boolean(
    actor?.is_platform_admin ||
    actor?.is_super_admin ||
    roles.includes("platform-admin") ||
    roles.includes("super-admin"),
  );
}

export function canManageCapability(actor: AuthUser | undefined, capabilityId: string): boolean {
  if (isPlatformAdmin(actor)) return true;
  const normalizedCapabilityId = capabilityId.trim().toLowerCase();
  if (!normalizedCapabilityId) return false;
  const capabilityIds = new Set(
    (actor?.capability_ids ?? [])
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
  if (capabilityIds.has(normalizedCapabilityId)) return true;
  const roles = rolesOf(actor);
  return roles.includes(`capability-owner:${normalizedCapabilityId}`) || roles.includes(`owner:${normalizedCapabilityId}`);
}

export function requirePlatformAdmin(actor: AuthUser | undefined, action: string): void {
  if (!isPlatformAdmin(actor)) {
    throw new ForbiddenError(`${action} requires platform admin access`);
  }
}

export function requireCapabilityOwner(actor: AuthUser | undefined, capabilityId: string, action: string): void {
  if (!canManageCapability(actor, capabilityId)) {
    throw new ForbiddenError(`${action} requires ownership of capability ${capabilityId}`);
  }
}
