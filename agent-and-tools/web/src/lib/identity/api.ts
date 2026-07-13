"use client";

import { apiPath, authHeaders, invalidApiResponseMessage, readResponseBody, responseMessage } from "@/lib/api";

export type IdentityView =
  | "dashboard"
  | "users"
  | "teams"
  | "business-units"
  | "capabilities"
  | "capability-graph"
  | "roles"
  | "permissions"
  | "sharing-grants"
  | "audit"
  | "authz-check"
  | "mcp-servers";

export type PageResponse<T> = {
  items: T[];
  total: number;
  page?: number;
  size?: number;
};

export type IdentityRow = Record<string, unknown> & { id?: string };

export type CapabilityRelationshipRow = {
  id?: string;
  source_capability_id?: string;
  target_capability_id?: string;
  relationship_type?: string;
  inheritance_policy?: string;
  [key: string]: unknown;
};

export type AuthzCheckRequest = {
  user_id: string;
  capability_id: string;
  action: string;
  tenant_id: string;
  resource_type?: string;
  resource_id?: string;
  requesting_capability_id?: string;
};

export type AuthzCheckResponse = {
  allowed: boolean;
  reason?: string;
  roles?: string[];
  permissions?: string[];
  source?: string;
  [key: string]: unknown;
};

export class IdentityError extends Error {
  constructor(message: string, public status?: number, public code?: string) {
    super(message);
    this.name = "IdentityError";
  }
}

async function identityRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `/api/iam${path.startsWith("/") ? path : `/${path}`}`;
  let res: Response;
  try {
    res = await fetch(apiPath(url), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new IdentityError(err instanceof Error ? err.message : "Identity network request failed");
  }
  const { raw, parsed, parseError } = await readResponseBody(res);
  if (!res.ok) {
    const obj = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    throw new IdentityError(
      responseMessage(parsed, raw, res.statusText),
      res.status,
      typeof obj.code === "string" ? obj.code : undefined,
    );
  }
  if (parseError) {
    throw new IdentityError(invalidApiResponseMessage(url, raw, parseError), res.status, "INVALID_API_RESPONSE");
  }
  return parsed as T;
}

export function listIdentity(view: IdentityView, size = 100): Promise<PageResponse<IdentityRow>> {
  const path = pathFor(view);
  return identityRequest<PageResponse<IdentityRow>>(`${path}?page=1&size=${size}`);
}

export function checkAuthorization(body: AuthzCheckRequest): Promise<AuthzCheckResponse> {
  return identityRequest<AuthzCheckResponse>("/authz/check", { method: "POST", body: JSON.stringify(body) });
}

// IAM org entities that can be created from the Identity console. Each maps to a
// POST on its list path (all super-admin gated server-side; a 403 surfaces as an
// IdentityError in the create form). MCP servers are capability-scoped and live
// on a separate surface, so they are intentionally not here.
export const CREATABLE_VIEWS: IdentityView[] = ["business-units", "teams", "users", "roles", "permissions", "capabilities"];

export function createIdentity(view: IdentityView, body: Record<string, unknown>): Promise<IdentityRow> {
  return identityRequest<IdentityRow>(pathFor(view), { method: "POST", body: JSON.stringify(body) });
}

// MCP servers are registered per capability (POST/GET /capabilities/{id}/mcp-servers).
export function listMcpServers(capabilityId: string): Promise<PageResponse<IdentityRow> | IdentityRow[]> {
  return identityRequest(`/capabilities/${encodeURIComponent(capabilityId)}/mcp-servers`);
}

export function createMcpServer(capabilityId: string, body: Record<string, unknown>): Promise<IdentityRow> {
  return identityRequest<IdentityRow>(`/capabilities/${encodeURIComponent(capabilityId)}/mcp-servers`, { method: "POST", body: JSON.stringify(body) });
}

// Edit an IAM org entity by its identifier (bu_id/team_id/user_id are UUIDs;
// capability PATCH keys off the capability_id key — the caller passes the right
// value). Roles have no PATCH endpoint, so they aren't editable here.
export function updateIdentity(view: IdentityView, id: string, body: Record<string, unknown>): Promise<IdentityRow> {
  return identityRequest<IdentityRow>(`${pathFor(view)}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function setLocalPassword(userId: string, password: string): Promise<{ user_id: string; auth_provider: string; is_local_account: boolean }> {
  return identityRequest(`/users/${encodeURIComponent(userId)}/password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

// Delete a permission key from the catalog. IAM blocks this (409) while the key
// is still granted to any role, so the caller should surface that message.
// Create/edit go through createIdentity/updateIdentity("permissions", …) — only
// delete has no generic entry point, hence this dedicated helper.
export function deletePermission(permissionKey: string): Promise<void> {
  return identityRequest<void>(`/permissions/${encodeURIComponent(permissionKey)}`, { method: "DELETE" });
}

export function updateMcpServer(serverId: string, body: Record<string, unknown>): Promise<IdentityRow> {
  return identityRequest<IdentityRow>(`/mcp-servers/${encodeURIComponent(serverId)}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteMcpServer(serverId: string): Promise<void> {
  return identityRequest<void>(`/mcp-servers/${encodeURIComponent(serverId)}`, { method: "DELETE" });
}

export function listCapabilityRelationships(capabilityId: string): Promise<CapabilityRelationshipRow[]> {
  return identityRequest<CapabilityRelationshipRow[]>(`/capabilities/${encodeURIComponent(capabilityId)}/relationships`);
}

// ── Relationship operations ──────────────────────────────────────────────────
// user↔team membership, user↔role assignment, and capability members. All hit
// the IAM service's first-class relationship endpoints through the same /api/iam
// proxy — used by the identity console's create-time pickers and the membership
// management panels. List endpoints may return a bare array or a {items:[]} page,
// so callers normalize with `asRows()`.

export type MembershipRow = Record<string, unknown> & { id?: string };

/** Normalize a list endpoint that may return `T[]` or `{items:T[]}`. */
export function asRows(value: unknown): MembershipRow[] {
  if (Array.isArray(value)) return value as MembershipRow[];
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: MembershipRow[] }).items;
  }
  return [];
}

// user ↔ role
export function listUserRoles(userId: string): Promise<unknown> {
  return identityRequest(`/users/${encodeURIComponent(userId)}/roles`);
}
export function assignUserRole(userId: string, roleKey: string): Promise<unknown> {
  return identityRequest(`/users/${encodeURIComponent(userId)}/roles`, { method: "POST", body: JSON.stringify({ role_key: roleKey }) });
}
export function revokeUserRole(userId: string, roleKey: string): Promise<void> {
  return identityRequest<void>(`/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleKey)}`, { method: "DELETE" });
}

// role ↔ permission — this is where a role gets its *access*. A role is just a
// named bag of permission keys; assigning permissions here is what makes an
// "Architect"/"BA"/"admin" role actually grant anything. All three are
// super-admin gated server-side (IAM /roles/{key}/permissions). The list may
// return a bare array or a {items:[]} page, so callers normalize with asRows().
export function listRolePermissions(roleKey: string): Promise<unknown> {
  return identityRequest(`/roles/${encodeURIComponent(roleKey)}/permissions`);
}
export function addRolePermission(roleKey: string, permissionKey: string): Promise<unknown> {
  return identityRequest(`/roles/${encodeURIComponent(roleKey)}/permissions`, { method: "POST", body: JSON.stringify({ permission_key: permissionKey }) });
}
export function removeRolePermission(roleKey: string, permissionKey: string): Promise<void> {
  return identityRequest<void>(`/roles/${encodeURIComponent(roleKey)}/permissions/${encodeURIComponent(permissionKey)}`, { method: "DELETE" });
}

// user ↔ team
export function listUserTeams(userId: string): Promise<unknown> {
  return identityRequest(`/users/${encodeURIComponent(userId)}/teams`);
}
export function listTeamMembers(teamId: string): Promise<unknown> {
  return identityRequest(`/teams/${encodeURIComponent(teamId)}/members`);
}
export function addTeamMember(teamId: string, userId: string, membershipType = "member"): Promise<unknown> {
  return identityRequest(`/teams/${encodeURIComponent(teamId)}/members`, { method: "POST", body: JSON.stringify({ user_id: userId, membership_type: membershipType }) });
}
export function removeTeamMember(teamId: string, userId: string): Promise<void> {
  return identityRequest<void>(`/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

// capability ↔ user/team (role-scoped)
export function listCapabilityMembers(capabilityId: string): Promise<unknown> {
  return identityRequest(`/capabilities/${encodeURIComponent(capabilityId)}/members`);
}
export function addCapabilityMember(capabilityId: string, body: { user_id?: string; team_id?: string; role_key: string }): Promise<unknown> {
  return identityRequest(`/capabilities/${encodeURIComponent(capabilityId)}/members`, { method: "POST", body: JSON.stringify(body) });
}

function pathFor(view: IdentityView): string {
  if (view === "users" || view === "dashboard") return "/users";
  if (view === "teams") return "/teams";
  if (view === "business-units") return "/business-units";
  if (view === "capabilities" || view === "capability-graph") return "/capabilities";
  if (view === "roles") return "/roles";
  if (view === "permissions" || view === "authz-check") return "/permissions";
  if (view === "sharing-grants") return "/capability-sharing-grants";
  if (view === "audit") return "/audit-events";
  return "/users";
}
