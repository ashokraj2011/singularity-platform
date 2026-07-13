import { getIamServiceAuthHeader } from "../../lib/iam/service-token";
import { readUpstreamJsonObject } from "../../shared/upstream-json";

const DEFAULT_IAM_BASE_URL = "http://localhost:8100";

export type IamCapabilityReference = {
  id: string;
  capability_id: string;
  name: string;
  status?: string;
  metadata?: Record<string, unknown>;
};

function authHeaders(authHeader?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (authHeader) headers.authorization = authHeader;
  return headers;
}

async function fetchWithServiceFallback(
  url: string,
  init: RequestInit,
  authHeader?: string,
): Promise<Response> {
  // A user bearer is preferred because IAM can apply the caller's own
  // visibility rules. Service-to-service materialization (for bootstrap jobs
  // and background workers) has no caller bearer, so authenticate it with the
  // scoped IAM service token instead of making an unauthenticated request.
  const caller = authHeader?.trim() || await getIamServiceAuthHeader();
  let response = await fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...(caller ? { authorization: caller } : {}) },
  });
  if ((response.status === 401 || response.status === 403) && authHeader) {
    const fallback = await getIamServiceAuthHeader();
    if (fallback && fallback !== authHeader) {
      response = await fetch(url, {
        ...init,
        headers: { ...authHeaders(), authorization: fallback },
      });
    }
  }
  return response;
}

function capabilityItems(body: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(body.items)) return body.items.filter(item => Boolean(item && typeof item === "object")) as Record<string, unknown>[];
  if (Array.isArray(body.data)) return body.data.filter(item => Boolean(item && typeof item === "object")) as Record<string, unknown>[];
  return [];
}

function referenceMatches(row: Record<string, unknown>, id: string): boolean {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
  return String(row.id ?? "") === id
    || String(row.capability_id ?? "") === id
    || String(metadata.agentRuntimeCapabilityId ?? metadata.agent_runtime_capability_id ?? "") === id;
}

/**
 * Verify that a runtime capability is backed by an IAM capability. This is
 * intentionally read-only: Agent Runtime may materialize operational data,
 * but it must not create a new capability identity in IAM as a side effect.
 */
export async function requireIamCapabilityReference(
  capabilityId: string,
  authHeader?: string,
): Promise<IamCapabilityReference> {
  const response = await fetchWithServiceFallback(
    `${iamApiBase()}/capabilities?page=1&size=500`,
    { method: "GET" },
    authHeader,
  );
  if (!response.ok) {
    throw new Error(`IAM capability catalog unavailable (${response.status})`);
  }
  const body = await readUpstreamJsonObject(response, "IAM capability catalog");
  const row = capabilityItems(body).find(item => referenceMatches(item, capabilityId));
  if (!row) {
    throw new Error(`Capability ${capabilityId} must be created in IAM before Agent Runtime materialization.`);
  }
  const id = String(row.id ?? "").trim();
  const capabilityKey = String(row.capability_id ?? "").trim();
  const name = String(row.name ?? "").trim();
  if (!id || !capabilityKey || !name) throw new Error(`IAM capability ${capabilityId} returned an incomplete identity.`);
  if (String(row.status ?? "ACTIVE").toUpperCase() === "ARCHIVED") {
    throw new Error(`IAM capability ${capabilityId} is archived and cannot be materialized.`);
  }
  return {
    id,
    capability_id: capabilityKey,
    name,
    status: typeof row.status === "string" ? row.status : undefined,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : undefined,
  };
}

/** Update IAM-owned identity fields before changing the local runtime projection. */
export async function updateIamCapabilityReference(
  capabilityId: string,
  patch: Record<string, unknown>,
  authHeader?: string,
): Promise<IamCapabilityReference> {
  const reference = await requireIamCapabilityReference(capabilityId, authHeader);
  const response = await fetchWithServiceFallback(
    `${iamApiBase()}/capabilities/${encodeURIComponent(reference.capability_id)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
    authHeader,
  );
  if (!response.ok) throw new Error(`IAM capability update failed (${response.status})`);
  const body = await readUpstreamJsonObject(response, "IAM capability update");
  return {
    id: String(body.id ?? reference.id),
    capability_id: String(body.capability_id ?? reference.capability_id),
    name: String(body.name ?? reference.name),
    status: typeof body.status === "string" ? body.status : reference.status,
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata as Record<string, unknown> : reference.metadata,
  };
}

function iamApiBase(): string {
  const raw = (process.env.IAM_SERVICE_URL ?? process.env.IAM_BASE_URL ?? DEFAULT_IAM_BASE_URL).replace(/\/+$/, "");
  return raw.endsWith("/api/v1") ? raw : `${raw}/api/v1`;
}
