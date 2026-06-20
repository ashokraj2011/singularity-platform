"use client";

import { apiPath, authHeaders, readResponseBody, responseMessage } from "@/lib/api";

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
  | "authz-check";

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
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "IdentityError";
  }
}

async function identityRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiPath(`/api/iam${path.startsWith("/") ? path : `/${path}`}`), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) {
    throw new IdentityError(responseMessage(parsed, raw, res.statusText), res.status);
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
