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
export const CREATABLE_VIEWS: IdentityView[] = ["business-units", "teams", "users", "roles", "capabilities"];

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

export function listCapabilityRelationships(capabilityId: string): Promise<CapabilityRelationshipRow[]> {
  return identityRequest<CapabilityRelationshipRow[]>(`/capabilities/${encodeURIComponent(capabilityId)}/relationships`);
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
