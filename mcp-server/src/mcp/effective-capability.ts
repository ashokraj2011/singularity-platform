import { AppError } from "../shared/errors";
import { config } from "../config";

const CAPABILITY_PERMISSIONS = new Set(["read", "invoke", "configure", "edit"]);

export type EffectiveCapabilityRunContext = Record<string, unknown> & {
  effectiveCapabilities?: unknown;
  effective_capabilities?: unknown;
  effectiveCapabilitiesRequired?: unknown;
  effective_capabilities_required?: unknown;
  profileSnapshotHash?: unknown;
  profile_snapshot_hash?: unknown;
};

function permissionValues(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.entries(raw as Record<string, unknown>)
        .filter(([, enabled]) => Boolean(enabled))
        .map(([name]) => name)
      : [];
  const out: string[] = [];
  for (const item of values) {
    const permission = String(item).trim().toLowerCase();
    if (CAPABILITY_PERMISSIONS.has(permission) && !out.includes(permission)) out.push(permission);
  }
  return out;
}

function stringValues(record: Record<string, unknown>, keys: string[]): string[] {
  return keys
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function capabilityPermissions(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.entries(raw as Record<string, unknown>)
        .filter(([, enabled]) => Boolean(enabled))
        .map(([name]) => name)
      : [];
  return permissionValues(values);
}

function effectiveCapabilitiesFromRunContext(
  runContext: EffectiveCapabilityRunContext,
): Record<string, unknown>[] {
  const raw = runContext.effectiveCapabilities ?? runContext.effective_capabilities;
  return Array.isArray(raw)
    ? raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function effectiveCapabilitiesRequired(runContext: EffectiveCapabilityRunContext): boolean {
  const raw = runContext.effectiveCapabilitiesRequired ?? runContext.effective_capabilities_required;
  if (raw === true || (typeof raw === "string" && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase()))) {
    return true;
  }
  if (config.MCP_REQUIRE_EFFECTIVE_CAPABILITIES) return true;
  const profileSnapshotHash = runContext.profileSnapshotHash ?? runContext.profile_snapshot_hash;
  return typeof profileSnapshotHash === "string" && profileSnapshotHash.trim().length > 0;
}

export function effectiveCapabilityDecision(
  toolName: string,
  runContext: EffectiveCapabilityRunContext,
): { allowed: true; enforced: boolean } | { allowed: false; reason: string } {
  const capabilities = effectiveCapabilitiesFromRunContext(runContext);
  if (capabilities.length === 0 && effectiveCapabilitiesRequired(runContext)) {
    return { allowed: false, reason: "effective capability set required" };
  }
  if (capabilities.length === 0) return { allowed: true, enforced: false };

  const capabilityIndex = new Map<string, Record<string, unknown>>();
  for (const capability of capabilities) {
    for (const name of stringValues(capability, ["id", "capabilityId", "capability_id", "name", "skillName", "skill_name", "toolName", "tool_name"])) {
      capabilityIndex.set(name, capability);
    }
  }

  const capability = capabilityIndex.get(toolName);
  if (!capability) return { allowed: false, reason: "no matching capability" };

  if (!capabilityPermissions(capability.permissions).includes("invoke")) {
    return { allowed: false, reason: "missing invoke" };
  }

  return { allowed: true, enforced: true };
}

export function assertEffectiveCapabilityAllowsTool(
  toolName: string,
  runContext: EffectiveCapabilityRunContext,
): void {
  const decision = effectiveCapabilityDecision(toolName, runContext);
  if (decision.allowed) return;
  throw new AppError(
    `Cannot dispatch tool=${toolName} — effective agent profile capability set denied invoke: ${decision.reason}`,
    403,
    "EFFECTIVE_CAPABILITY_DENIED",
    {
      tool_name: toolName,
      reason: decision.reason,
      profileSnapshotHash: runContext.profileSnapshotHash ?? runContext.profile_snapshot_hash,
    },
  );
}
