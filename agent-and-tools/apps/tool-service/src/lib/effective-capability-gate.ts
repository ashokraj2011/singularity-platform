const CAPABILITY_PERMISSIONS = new Set(["read", "invoke", "configure", "edit"]);

export type EffectiveCapabilityForGate = {
  id?: unknown;
  capabilityId?: unknown;
  capability_id?: unknown;
  name?: unknown;
  skillName?: unknown;
  skill_name?: unknown;
  toolName?: unknown;
  tool_name?: unknown;
  permissions?: unknown;
  readOnly?: unknown;
  read_only?: unknown;
  providerLocked?: unknown;
  provider_locked?: unknown;
  providerId?: unknown;
  provider_id?: unknown;
  providerManifestVersion?: unknown;
  provider_manifest_version?: unknown;
  providerManifestDigest?: unknown;
  provider_manifest_digest?: unknown;
  providerManifestSignatureKeyId?: unknown;
  provider_manifest_signature_key_id?: unknown;
  providerManifestSigned?: unknown;
  provider_manifest_signed?: unknown;
  sourceType?: unknown;
  source_type?: unknown;
  sourceRef?: unknown;
  source_ref?: unknown;
};

export type CapabilityGateInput = {
  effectiveCapabilities?: unknown;
  effectiveCapabilitiesProvided?: unknown;
  requireEffectiveCapabilities?: unknown;
  requestedCapabilityId?: unknown;
  requestedPermission?: unknown;
  toolName: string;
};

export type CapabilityGateDecision =
  | { allowed: true; enforced: boolean; capabilityId?: string; permission?: string; matchingCapability?: EffectiveCapabilityForGate }
  | { allowed: false; enforced: true; reason: string; capabilityId?: string; permission?: string };

function asArray(value: unknown): EffectiveCapabilityForGate[] {
  return Array.isArray(value) ? value as EffectiveCapabilityForGate[] : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return false;
}

function permissionsOf(value: unknown): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    value = Object.entries(value as Record<string, unknown>)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([name]) => name);
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const permission = asString(item)?.toLowerCase();
    if (permission && CAPABILITY_PERMISSIONS.has(permission) && !out.includes(permission)) out.push(permission);
  }
  return out;
}

function capabilityNames(capability: EffectiveCapabilityForGate): string[] {
  return [
    capability.id,
    capability.capabilityId,
    capability.capability_id,
    capability.name,
    capability.skillName,
    capability.skill_name,
    capability.toolName,
    capability.tool_name,
  ]
    .map(asString)
    .filter((value): value is string => Boolean(value));
}

export function effectiveCapabilityGate(input: CapabilityGateInput): CapabilityGateDecision {
  const effectiveCapabilities = asArray(input.effectiveCapabilities);
  const provided = asBoolean(input.effectiveCapabilitiesProvided) || Array.isArray(input.effectiveCapabilities);
  const required = asBoolean(input.requireEffectiveCapabilities);
  if (!provided && effectiveCapabilities.length === 0) {
    if (required) {
      return {
        allowed: false,
        enforced: true,
        reason: "Effective capability set is required for governed tool access",
      };
    }
    return { allowed: true, enforced: false };
  }

  const requestedPermission = asString(input.requestedPermission)?.toLowerCase() ?? "invoke";
  if (!CAPABILITY_PERMISSIONS.has(requestedPermission)) {
    return {
      allowed: false,
      enforced: true,
      reason: `Unsupported capability permission: ${requestedPermission}`,
      permission: requestedPermission,
    };
  }

  const requestedCapabilityId = asString(input.requestedCapabilityId) ?? input.toolName;
  if (effectiveCapabilities.length === 0) {
    return {
      allowed: false,
      enforced: true,
      reason: `Capability ${requestedCapabilityId} is not present in the effective profile capability set`,
      capabilityId: requestedCapabilityId,
      permission: requestedPermission,
    };
  }

  const matching = effectiveCapabilities.find((capability) => capabilityNames(capability).includes(requestedCapabilityId));
  if (!matching) {
    return {
      allowed: false,
      enforced: true,
      reason: `Capability ${requestedCapabilityId} is not present in the effective profile capability set`,
      capabilityId: requestedCapabilityId,
      permission: requestedPermission,
    };
  }

  const permissions = permissionsOf(matching.permissions);
  if (!permissions.includes(requestedPermission)) {
    const readOnly = Boolean(matching.readOnly ?? matching.read_only);
    const providerLocked = Boolean(matching.providerLocked ?? matching.provider_locked);
    const lockSuffix = readOnly || providerLocked
      ? ` (${[readOnly ? "read-only" : null, providerLocked ? "provider-locked" : null].filter(Boolean).join(", ")})`
      : "";
    return {
      allowed: false,
      enforced: true,
      reason: `Capability ${requestedCapabilityId} does not allow ${requestedPermission}${lockSuffix}`,
      capabilityId: requestedCapabilityId,
      permission: requestedPermission,
    };
  }

  return {
    allowed: true,
    enforced: true,
    capabilityId: requestedCapabilityId,
    permission: requestedPermission,
    matchingCapability: matching,
  };
}
