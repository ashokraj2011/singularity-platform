export type Row = Record<string, unknown>;

export type CapabilityPermission = "read" | "invoke" | "configure" | "edit";

export type AgentStudioAgent = {
  id: string;
  name: string;
  description?: string;
  roleType?: string;
  capabilityId?: string | null;
  baseTemplateId?: string | null;
  lockedReason?: string | null;
  basePromptProfileId?: string | null;
  editable?: boolean;
  status?: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type AgentStudioCapability = {
  id: string;
  name?: string;
  capabilityType?: string | null;
  status?: string;
};

export type AgentStudioSkill = {
  id: string;
  name: string;
  description?: string;
  skillType?: string;
};

export type AgentStudioPromptProfile = {
  id: string;
  name?: string;
  description?: string | null;
  layers?: Array<{
    id: string;
    priority?: number;
    isEnabled?: boolean;
    promptLayer?: {
      id: string;
      name?: string;
      layerType?: string;
      scopeType?: string;
      content?: string;
    };
  }>;
};

export type AgentStudioVersion = {
  id: string;
  version: number;
  changeSummary?: string | null;
  snapshot?: Row;
  createdBy?: string | null;
  createdAt?: string;
};

export type AgentStudioProviderCapability = {
  id?: string;
  name?: string;
  description?: string;
  permissions?: CapabilityPermission[];
  defaultPermissions?: CapabilityPermission[];
  readOnly?: boolean;
  providerLocked?: boolean;
  constraints?: {
    readOnly?: boolean;
    providerLocked?: boolean;
  };
  schema?: unknown;
  invocationEndpoint?: string;
};

export type AgentStudioProviderPreview = {
  title?: string;
  description?: string;
  sourceRef?: string;
  defaultPermissions?: CapabilityPermission[];
  readOnly?: boolean;
  providerLocked?: boolean;
  capabilities?: AgentStudioProviderCapability[];
  manifestVersion?: unknown;
};

export type AgentStudioSourceGovernance = {
  bindingId?: string;
  skillId: string;
  skillName: string;
  skillType: string;
  sourceType: string;
  sourceRef?: string | null;
  capabilityId?: string | null;
  permissions?: CapabilityPermission[];
  readOnly?: boolean;
  providerLocked?: boolean;
  liveResolutionRequired?: boolean;
  sourceArtifact?: { kind?: string; id?: string; sourceRef?: string; title?: string } | Row;
  warnings?: string[];
};

export type AgentStudioSourcesResponse = {
  sources: AgentStudioSourceGovernance[];
  summary: {
    totalBindings: number;
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
};

const VALID_PERMISSIONS = new Set<CapabilityPermission>(["read", "invoke", "configure", "edit"]);

export function normalizeCapabilityListResponse(value: unknown): AgentStudioCapability[] {
  return rowsFromListResponse(value)
    .map(normalizeCapability)
    .filter((row): row is AgentStudioCapability => Boolean(row));
}

export function normalizeAgentListResponse(value: unknown): AgentStudioAgent[] {
  return rowsFromListResponse(value)
    .map(normalizeAgent)
    .filter((row): row is AgentStudioAgent => Boolean(row));
}

export function normalizeSkillListResponse(value: unknown): AgentStudioSkill[] {
  return rowsFromListResponse(value)
    .map(normalizeSkill)
    .filter((row): row is AgentStudioSkill => Boolean(row));
}

export function normalizePromptProfileListResponse(value: unknown): AgentStudioPromptProfile[] {
  return rowsFromListResponse(value)
    .map(normalizePromptProfile)
    .filter((row): row is AgentStudioPromptProfile => Boolean(row));
}

export function normalizeAgentVersionListResponse(value: unknown): AgentStudioVersion[] {
  return rowsFromListResponse(value)
    .map(normalizeAgentVersion)
    .filter((row): row is AgentStudioVersion => Boolean(row));
}

export function normalizeAgentProfileCreateResponse(value: unknown): AgentStudioAgent | null {
  const record = asRecord(value);
  if (!record) return normalizeAgent(value);
  return normalizeAgent(record.template) ?? normalizeAgent(record.profile) ?? normalizeAgent(record.agent) ?? normalizeAgent(record);
}

export function normalizeProviderPreviewResponse(value: unknown): AgentStudioProviderPreview | null {
  const record = asRecord(value);
  if (!record) return null;
  const constraints = asRecord(record.constraints);
  const capabilities = recordArray(record.capabilities)
    .map(normalizeProviderCapability)
    .filter((row): row is AgentStudioProviderCapability => Boolean(row));
  return {
    title: text(record.title) || text(record.name) || "Provider source",
    description: text(record.description) || undefined,
    sourceRef: text(record.sourceRef) || text(record.providerManifestUrl) || text(record.url) || undefined,
    defaultPermissions: permissions(record.defaultPermissions),
    readOnly: bool(record.readOnly, bool(constraints?.readOnly, capabilities.every(capability => capability.readOnly))),
    providerLocked: bool(record.providerLocked, bool(constraints?.providerLocked, capabilities.some(capability => capability.providerLocked))),
    capabilities,
    manifestVersion: record.manifestVersion,
  };
}

export function normalizePromptProfileResponse(value: unknown): AgentStudioPromptProfile | null {
  return normalizePromptProfile(value);
}

export function normalizeProfileSourcesResponse(value: unknown): AgentStudioSourcesResponse {
  const record = asRecord(value) ?? {};
  const summary = asRecord(record.summary) ?? {};
  return {
    sources: recordArray(record.sources)
      .map(normalizeSourceGovernance)
      .filter((row): row is AgentStudioSourceGovernance => Boolean(row)),
    summary: {
      totalBindings: number(summary.totalBindings),
      externalBindings: number(summary.externalBindings),
      providerManifestBindings: number(summary.providerManifestBindings),
      documentBindings: number(summary.documentBindings),
      readOnlyBindings: number(summary.readOnlyBindings),
      providerLockedBindings: number(summary.providerLockedBindings),
      invokableBindings: number(summary.invokableBindings),
      liveResolutionRequired: number(summary.liveResolutionRequired),
      missingSourceRefs: number(summary.missingSourceRefs),
      knowledgeSources: number(summary.knowledgeSources),
      knowledgeArtifacts: number(summary.knowledgeArtifacts),
      warnings: stringArray(summary.warnings),
    },
  };
}

export function normalizeSkill(value: unknown): AgentStudioSkill | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = text(record.id) || text(record.skillId) || text(record.skill_id);
  if (!id) return null;
  return {
    id,
    name: text(record.name) || text(record.skillName) || id,
    description: text(record.description) || undefined,
    skillType: text(record.skillType) || text(record.skill_type) || undefined,
  };
}

export function normalizeAgent(value: unknown): AgentStudioAgent | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = text(record.id) || text(record.templateId) || text(record.template_id);
  if (!id) return null;
  return {
    id,
    name: text(record.name) || text(record.templateName) || id,
    description: text(record.description) || undefined,
    roleType: text(record.roleType) || text(record.role_type) || undefined,
    capabilityId: nullableText(record.capabilityId) ?? nullableText(record.capability_id),
    baseTemplateId: nullableText(record.baseTemplateId) ?? nullableText(record.base_template_id),
    lockedReason: nullableText(record.lockedReason) ?? nullableText(record.locked_reason),
    basePromptProfileId: nullableText(record.basePromptProfileId) ?? nullableText(record.base_prompt_profile_id),
    editable: maybeBool(record.editable),
    status: text(record.status) || undefined,
    version: number(record.version, 1),
    createdAt: text(record.createdAt) || text(record.created_at) || undefined,
    updatedAt: text(record.updatedAt) || text(record.updated_at) || undefined,
  };
}

function normalizeCapability(value: unknown): AgentStudioCapability | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = text(record.id) || text(record.capabilityId) || text(record.capability_id);
  if (!id) return null;
  return {
    id,
    name: text(record.name) || text(record.capabilityName) || text(record.capability_name) || id,
    capabilityType: text(record.capabilityType) || text(record.capability_type) || null,
    status: text(record.status) || undefined,
  };
}

function normalizePromptProfile(value: unknown): AgentStudioPromptProfile | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = text(record.id) || text(record.profileId) || text(record.profile_id);
  if (!id) return null;
  return {
    id,
    name: text(record.name) || id,
    description: nullableText(record.description),
    layers: recordArray(record.layers)
      .map(normalizePromptProfileLayer)
      .filter((row): row is NonNullable<AgentStudioPromptProfile["layers"]>[number] => Boolean(row)),
  };
}

function normalizePromptProfileLayer(value: unknown): NonNullable<AgentStudioPromptProfile["layers"]>[number] | null {
  const record = asRecord(value);
  if (!record) return null;
  const promptLayer = asRecord(record.promptLayer) ?? asRecord(record.prompt_layer);
  const id = text(record.id) || text(promptLayer?.id);
  if (!id) return null;
  return {
    id,
    priority: number(record.priority),
    isEnabled: maybeBool(record.isEnabled ?? record.is_enabled),
    promptLayer: promptLayer ? {
      id: text(promptLayer.id) || id,
      name: text(promptLayer.name) || undefined,
      layerType: text(promptLayer.layerType) || text(promptLayer.layer_type) || undefined,
      scopeType: text(promptLayer.scopeType) || text(promptLayer.scope_type) || undefined,
      content: text(promptLayer.content) || undefined,
    } : undefined,
  };
}

function normalizeAgentVersion(value: unknown): AgentStudioVersion | null {
  const record = asRecord(value);
  if (!record) return null;
  const version = number(record.version);
  const id = text(record.id) || (version > 0 ? `version-${version}` : "");
  if (!id || version <= 0) return null;
  return {
    id,
    version,
    changeSummary: nullableText(record.changeSummary) ?? nullableText(record.change_summary),
    snapshot: asRecord(record.snapshot) ?? undefined,
    createdBy: nullableText(record.createdBy) ?? nullableText(record.created_by),
    createdAt: text(record.createdAt) || text(record.created_at) || undefined,
  };
}

function normalizeProviderCapability(value: unknown): AgentStudioProviderCapability | null {
  const record = asRecord(value);
  if (!record) return null;
  const constraints = asRecord(record.constraints);
  const id = text(record.id) || text(record.capabilityId) || text(record.name);
  const name = text(record.name) || id || "Provider capability";
  if (!id && !name) return null;
  return {
    id: id || undefined,
    name,
    description: text(record.description) || undefined,
    permissions: permissions(record.permissions, permissions(record.defaultPermissions, ["read"])),
    defaultPermissions: permissions(record.defaultPermissions),
    readOnly: bool(record.readOnly, bool(constraints?.readOnly, false)),
    providerLocked: bool(record.providerLocked, bool(constraints?.providerLocked, false)),
    constraints: constraints ? {
      readOnly: bool(constraints.readOnly, false),
      providerLocked: bool(constraints.providerLocked, false),
    } : undefined,
    schema: record.schema,
    invocationEndpoint: text(record.invocationEndpoint) || text(record.invocation_endpoint) || undefined,
  };
}

function normalizeSourceGovernance(value: unknown): AgentStudioSourceGovernance | null {
  const record = asRecord(value);
  if (!record) return null;
  const skillId = text(record.skillId) || text(record.skill_id) || text(record.id);
  if (!skillId) return null;
  return {
    bindingId: text(record.bindingId) || text(record.binding_id) || undefined,
    skillId,
    skillName: text(record.skillName) || text(record.skill_name) || text(record.name) || skillId,
    skillType: text(record.skillType) || text(record.skill_type) || "SOURCE",
    sourceType: text(record.sourceType) || text(record.source_type) || "local",
    sourceRef: nullableText(record.sourceRef) ?? nullableText(record.source_ref),
    capabilityId: nullableText(record.capabilityId) ?? nullableText(record.capability_id),
    permissions: permissions(record.permissions, ["read"]),
    readOnly: bool(record.readOnly, false),
    providerLocked: bool(record.providerLocked, false),
    liveResolutionRequired: bool(record.liveResolutionRequired, false),
    sourceArtifact: asRecord(record.sourceArtifact) ?? asRecord(record.source_artifact) ?? undefined,
    warnings: stringArray(record.warnings),
  };
}

function rowsFromListResponse(value: unknown): Row[] {
  const rows = Array.isArray(value)
    ? value
    : firstArrayField(value, "items", "agents", "templates", "skills", "profiles", "versions", "sources", "data", "rows");
  return rows.filter((item): item is Row => Boolean(asRecord(item)));
}

function firstArrayField(value: unknown, ...keys: string[]): unknown[] {
  const record = asRecord(value);
  if (!record) return [];
  for (const key of keys) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function recordArray(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => Boolean(asRecord(item))) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : [];
}

function permissions(value: unknown, fallback: CapabilityPermission[] = []): CapabilityPermission[] {
  const seen = new Set<CapabilityPermission>();
  for (const item of Array.isArray(value) ? value : fallback) {
    const permission = text(item).toLowerCase() as CapabilityPermission;
    if (VALID_PERMISSIONS.has(permission)) seen.add(permission);
  }
  return Array.from(seen);
}

function asRecord(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  const next = text(value);
  return next || undefined;
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function maybeBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  return maybeBool(value) ?? fallback;
}
