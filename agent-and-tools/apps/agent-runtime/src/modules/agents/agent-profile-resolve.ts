import { createHash } from "crypto";

export const CAPABILITY_PERMISSIONS = ["read", "invoke", "configure", "edit"] as const;
export type CapabilityPermission = typeof CAPABILITY_PERMISSIONS[number];
export type SkillSourceType = "local" | "provider_manifest" | "url_document" | "uploaded_document";

const PERMISSION_SET = new Set<string>(CAPABILITY_PERMISSIONS);

export type ProfileSkillForResolution = {
  skillId: string;
  skillName: string;
  skillType: string;
  sourceType: SkillSourceType | string;
  sourceRef?: string | null;
  capabilityId?: string | null;
  permissions?: unknown;
  readOnly?: boolean | null;
  providerLocked?: boolean | null;
  metadata?: unknown;
};

export type ManifestCapability = {
  id?: unknown;
  capability_id?: unknown;
  name?: unknown;
  description?: unknown;
  permissions?: unknown;
  capability_permissions?: unknown;
  constraints?: unknown;
  schema?: unknown;
  input_schema?: unknown;
  inputSchema?: unknown;
  endpoint?: unknown;
  invocation_endpoint?: unknown;
};

export type ProviderManifestForResolution = {
  name?: unknown;
  provider?: unknown;
  version?: unknown;
  manifest_version?: unknown;
  manifestVersion?: unknown;
  capabilities?: unknown;
  skills?: unknown;
};

export type ProviderResolution =
  | {
      sourceRef: string;
      status: "resolved";
      providerName: string;
      manifestVersion: string | null;
      manifestDigest?: string;
      signatureKeyId?: string | null;
      signedManifest?: boolean;
      capabilityCount: number;
    }
  | {
      sourceRef: string;
      status: "failed_closed";
      error: string;
      capabilityCount: 0;
    };

export type EffectiveCapability = {
  id: string;
  name: string;
  description?: string;
  sourceType: string;
  sourceRef?: string | null;
  skillId: string;
  skillName: string;
  skillType: string;
  permissions: CapabilityPermission[];
  readOnly: boolean;
  providerLocked: boolean;
  providerId?: string;
  providerManifestVersion?: string | null;
  providerManifestDigest?: string;
  providerManifestSignatureKeyId?: string | null;
  providerManifestSigned?: boolean;
  schema?: unknown;
  invocationEndpoint?: string;
};

export type ProfileSourceGovernance = {
  bindingId?: string;
  skillId: string;
  skillName: string;
  skillType: string;
  sourceType: string;
  sourceRef?: string | null;
  capabilityId?: string | null;
  permissions: CapabilityPermission[];
  readOnly: boolean;
  providerLocked: boolean;
  liveResolutionRequired: boolean;
  sourceArtifact?: unknown;
  warnings: string[];
};

export type ProfileSourceGovernanceSummary = {
  totalBindings: number;
  localBindings: number;
  externalBindings: number;
  providerManifestBindings: number;
  documentBindings: number;
  readOnlyBindings: number;
  providerLockedBindings: number;
  invokableBindings: number;
  liveResolutionRequired: number;
  missingSourceRefs: number;
  knowledgeSources: number;
  knowledgeArtifacts: number;
  warnings: string[];
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metadataValue(metadata: unknown, key: string): unknown {
  return objectValue(metadata)[key];
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || stableHash(input);
}

export function uniquePermissions(values: unknown, fallback: CapabilityPermission[]): CapabilityPermission[] {
  if (!Array.isArray(values)) return fallback;
  const out = values.filter((value): value is CapabilityPermission => typeof value === "string" && PERMISSION_SET.has(value));
  return out.length ? Array.from(new Set(out)) : fallback;
}

export function defaultPermissionsFor(sourceType: string): CapabilityPermission[] {
  return sourceType === "local" ? ["read", "invoke"] : ["read"];
}

export function normalizeCapabilityPermissions(
  values: unknown,
  fallback: CapabilityPermission[],
  constrainedToRead = false,
): CapabilityPermission[] {
  let permissions = uniquePermissions(values, fallback);
  if (constrainedToRead) permissions = permissions.filter((permission) => permission === "read");
  if (!permissions.includes("read")) permissions.unshift("read");
  return Array.from(new Set(permissions));
}

export function normalizeProfilePermissions(binding: {
  sourceType: string;
  permissions?: unknown;
  readOnly?: boolean | null;
  providerLocked?: boolean | null;
}): { permissions: CapabilityPermission[]; readOnly: boolean; providerLocked: boolean } {
  const providerLocked = binding.sourceType === "url_document" || binding.sourceType === "uploaded_document"
    ? true
    : Boolean(binding.providerLocked);
  const external = binding.sourceType !== "local";
  const readOnly = binding.readOnly ?? external;
  const permissions = normalizeCapabilityPermissions(
    binding.permissions,
    defaultPermissionsFor(binding.sourceType),
    readOnly || providerLocked,
  );
  return { permissions, readOnly, providerLocked };
}

function intersectPermissions(left: CapabilityPermission[], right: CapabilityPermission[]): CapabilityPermission[] {
  const allowed = new Set(right);
  const out = left.filter((permission) => allowed.has(permission));
  if (!out.includes("read") && left.includes("read") && right.includes("read")) out.unshift("read");
  return Array.from(new Set(out));
}

export function capabilitiesFromProviderManifest(manifest: ProviderManifestForResolution): ManifestCapability[] {
  const topLevel = Array.isArray(manifest.capabilities) ? manifest.capabilities as ManifestCapability[] : [];
  const skills = Array.isArray(manifest.skills) ? manifest.skills as Array<Record<string, unknown>> : [];
  const nested = skills.flatMap((skill) => Array.isArray(skill.capabilities) ? skill.capabilities as ManifestCapability[] : []);
  return [...topLevel, ...nested];
}

export function resolveLocalOrDocumentCapability(binding: ProfileSkillForResolution): EffectiveCapability {
  const normalized = normalizeProfilePermissions(binding);
  const sourceRef = binding.sourceRef ?? null;
  const metadataCapabilityId = stringValue(metadataValue(binding.metadata, "capabilityId"));
  const sourceKey = sourceRef ? stableHash(sourceRef) : stableHash(`${binding.skillId}:${binding.skillName}`);
  const id = metadataCapabilityId ?? (
    binding.sourceType === "local"
      ? `${slug(binding.skillType)}.${slug(binding.skillName)}`
      : `document.${sourceKey}.read`
  );
  return {
    id,
    name: stringValue(metadataValue(binding.metadata, "capabilityName")) ?? binding.skillName,
    description: stringValue(metadataValue(binding.metadata, "description")),
    sourceType: binding.sourceType,
    sourceRef,
    skillId: binding.skillId,
    skillName: binding.skillName,
    skillType: binding.skillType,
    permissions: normalized.permissions,
    readOnly: normalized.readOnly,
    providerLocked: normalized.providerLocked,
  };
}

export function resolveProviderCapabilities(
  binding: ProfileSkillForResolution,
  manifest: ProviderManifestForResolution,
  evidence: Pick<Extract<ProviderResolution, { status: "resolved" }>, "manifestDigest" | "signatureKeyId" | "signedManifest"> = {},
): { capabilities: EffectiveCapability[]; provider: ProviderResolution } {
  const sourceRef = binding.sourceRef ?? "";
  const profile = normalizeProfilePermissions(binding);
  const manifestCapabilities = capabilitiesFromProviderManifest(manifest);
  const providerName = stringValue(manifest.name) ?? stringValue(manifest.provider) ?? binding.skillName;
  const manifestVersion = stringValue(manifest.version) ?? stringValue(manifest.manifest_version) ?? stringValue(manifest.manifestVersion) ?? null;

  const capabilities = manifestCapabilities.map((capability, index): EffectiveCapability => {
    const capConstraints = objectValue(capability.constraints);
    const capReadOnly = Boolean(capConstraints.readOnly ?? capConstraints.read_only ?? profile.readOnly);
    const capProviderLocked = Boolean(capConstraints.providerLocked ?? capConstraints.provider_locked ?? profile.providerLocked);
    const providerPermissions = normalizeCapabilityPermissions(
      capability.permissions ?? capability.capability_permissions,
      ["read"],
      capReadOnly || capProviderLocked,
    );
    const permissions = intersectPermissions(profile.permissions, providerPermissions);
    const rawId = stringValue(capability.id) ?? stringValue(capability.capability_id) ?? stringValue(capability.name);
    const id = rawId ?? `${slug(providerName)}.${index + 1}`;
    return {
      id,
      name: stringValue(capability.name) ?? id,
      description: stringValue(capability.description),
      sourceType: binding.sourceType,
      sourceRef,
      skillId: binding.skillId,
      skillName: binding.skillName,
      skillType: binding.skillType,
      permissions,
      readOnly: profile.readOnly || capReadOnly,
      providerLocked: profile.providerLocked || capProviderLocked,
      providerId: providerName,
      providerManifestVersion: manifestVersion,
      providerManifestDigest: evidence.manifestDigest,
      providerManifestSignatureKeyId: evidence.signatureKeyId ?? null,
      providerManifestSigned: evidence.signedManifest ?? false,
      schema: capability.schema ?? capability.input_schema ?? capability.inputSchema,
      invocationEndpoint: stringValue(capability.endpoint) ?? stringValue(capability.invocation_endpoint),
    };
  }).filter((capability) => capability.permissions.length > 0);

  return {
    capabilities,
    provider: {
      sourceRef,
      status: "resolved",
      providerName,
      manifestVersion,
      manifestDigest: evidence.manifestDigest,
      signatureKeyId: evidence.signatureKeyId ?? null,
      signedManifest: evidence.signedManifest ?? false,
      capabilityCount: capabilities.length,
    },
  };
}

export function sortEffectiveCapabilities(capabilities: EffectiveCapability[]): EffectiveCapability[] {
  return [...capabilities].sort((a, b) => (
    `${a.sourceType}:${a.sourceRef ?? ""}:${a.id}:${a.skillId}`
      .localeCompare(`${b.sourceType}:${b.sourceRef ?? ""}:${b.id}:${b.skillId}`)
  ));
}

export function summarizeProfileSource(binding: ProfileSkillForResolution & { bindingId?: string }): ProfileSourceGovernance {
  const normalized = normalizeProfilePermissions(binding);
  const effectiveReadOnly = normalized.readOnly || normalized.providerLocked;
  const sourceArtifact = metadataValue(binding.metadata, "sourceArtifact");
  const warnings: string[] = [];
  const external = binding.sourceType !== "local";
  const sourceRef = binding.sourceRef ?? null;

  if (external && !sourceRef) warnings.push("external source has no sourceRef");
  if (binding.sourceType === "provider_manifest" && !sourceRef) warnings.push("provider manifest binding has no manifest URL");
  if (effectiveReadOnly && normalized.permissions.some((permission) => permission !== "read")) {
    warnings.push("read-only or provider-locked source has non-read permissions");
  }
  if (binding.sourceType === "provider_manifest" && effectiveReadOnly && normalized.permissions.includes("invoke")) {
    warnings.push("read-only provider manifest includes invoke permission");
  }

  return {
    bindingId: binding.bindingId,
    skillId: binding.skillId,
    skillName: binding.skillName,
    skillType: binding.skillType,
    sourceType: binding.sourceType,
    sourceRef,
    capabilityId: binding.capabilityId ?? null,
    permissions: normalized.permissions,
    readOnly: effectiveReadOnly,
    providerLocked: normalized.providerLocked,
    liveResolutionRequired: binding.sourceType === "provider_manifest",
    sourceArtifact,
    warnings,
  };
}

export function summarizeProfileSources(bindings: Array<ProfileSkillForResolution & { bindingId?: string }>): {
  sources: ProfileSourceGovernance[];
  summary: ProfileSourceGovernanceSummary;
} {
  const sources = bindings.map(summarizeProfileSource);
  const warnings = sources.flatMap((source) => source.warnings.map((warning) => `${source.skillName}: ${warning}`));
  return {
    sources,
    summary: {
      totalBindings: sources.length,
      localBindings: sources.filter((source) => source.sourceType === "local").length,
      externalBindings: sources.filter((source) => source.sourceType !== "local").length,
      providerManifestBindings: sources.filter((source) => source.sourceType === "provider_manifest").length,
      documentBindings: sources.filter((source) => source.sourceType === "url_document" || source.sourceType === "uploaded_document").length,
      readOnlyBindings: sources.filter((source) => source.readOnly).length,
      providerLockedBindings: sources.filter((source) => source.providerLocked).length,
      invokableBindings: sources.filter((source) => source.permissions.includes("invoke")).length,
      liveResolutionRequired: sources.filter((source) => source.liveResolutionRequired).length,
      missingSourceRefs: sources.filter((source) => source.sourceType !== "local" && !source.sourceRef).length,
      knowledgeSources: sources.filter((source) => objectValue(source.sourceArtifact).kind === "knowledge_source").length,
      knowledgeArtifacts: sources.filter((source) => objectValue(source.sourceArtifact).kind === "knowledge_artifact").length,
      warnings,
    },
  };
}
