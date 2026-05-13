import type { Capability } from "@prisma/client";

const DEFAULT_IAM_BASE_URL = "http://localhost:8100";

type SyncOptions = {
  authHeader?: string;
  metadata?: Record<string, unknown>;
};

export async function syncIamCapabilityReference(
  capability: Capability,
  options: SyncOptions = {},
): Promise<string | null> {
  const baseUrl = iamApiBase();
  const url = `${baseUrl}/capabilities/reference/${encodeURIComponent(capability.id)}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (options.authHeader) headers.authorization = options.authHeader;

  const ownerTeam = capability.ownerTeamId
    ? await fetchIamTeam(baseUrl, capability.ownerTeamId, headers)
    : null;
  if (capability.ownerTeamId && ownerTeam === false) {
    return `IAM capability reference sync skipped: ownerTeamId ${capability.ownerTeamId} was not found in IAM`;
  }
  const ownerTeamRecord = ownerTeam || null;

  const body = {
    id: capability.id,
    capability_id: capability.id,
    name: capability.name,
    description: capability.description ?? undefined,
    capability_type: toIamCapabilityType(capability.capabilityType),
    status: toIamStatus(capability.status),
    visibility: "private",
    tags: ["agent-and-tools"],
    metadata: {
      sourceService: "agent-runtime",
      sourceSystem: "agent-and-tools",
      bootstrapOwner: "agent-and-tools",
      agentRuntimeCapabilityId: capability.id,
      businessUnitId: capability.businessUnitId ?? undefined,
      ownerTeamId: ownerTeamRecord?.id ?? capability.ownerTeamId ?? undefined,
      ownerTeamKey: ownerTeamRecord?.team_key ?? undefined,
      ownerTeamName: ownerTeamRecord?.name ?? undefined,
      criticality: capability.criticality ?? undefined,
      ...options.metadata,
    },
  };

  try {
    const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `IAM capability reference sync skipped (${res.status}): ${text.slice(0, 180) || res.statusText}`;
    }
    return null;
  } catch (err) {
    return `IAM capability reference sync skipped: ${(err as Error).message}`;
  }
}

function iamApiBase(): string {
  const raw = (process.env.IAM_SERVICE_URL ?? process.env.IAM_BASE_URL ?? DEFAULT_IAM_BASE_URL).replace(/\/+$/, "");
  return raw.endsWith("/api/v1") ? raw : `${raw}/api/v1`;
}

async function fetchIamTeam(
  baseUrl: string,
  teamId: string,
  headers: Record<string, string>,
): Promise<{ id: string; team_key?: string; name?: string } | false | null> {
  try {
    const res = await fetch(`${baseUrl}/teams/${encodeURIComponent(teamId)}`, { headers });
    if (res.status === 404) return false;
    if (!res.ok) return null;
    const body = await res.json() as { id?: string; team_key?: string; name?: string };
    return body.id ? { id: body.id, team_key: body.team_key, name: body.name } : null;
  } catch {
    return null;
  }
}

function toIamCapabilityType(value?: string | null): string {
  const raw = (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (raw.includes("business")) return "business_capability";
  if (raw.includes("shared")) return "shared_capability";
  if (raw.includes("delivery")) return "delivery_capability";
  if (raw.includes("collection")) return "collection_capability";
  if (raw.includes("platform")) return "platform_capability";
  if (raw.includes("technical")) return "technical_capability";
  if (raw.includes("application")) return "application_capability";
  return "application_capability";
}

function toIamStatus(value?: string | null): string {
  const raw = (value ?? "ACTIVE").toLowerCase();
  if (raw === "archived") return "archived";
  if (raw === "suspended" || raw === "inactive") return "suspended";
  return "active";
}
