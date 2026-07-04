export type GalleryTemplate = {
  id?: string;
  name?: string;
  description?: string;
  workflowTypeKey?: string;
  capabilityId?: string | null;
};

export type GalleryItem = {
  id: string;
  label: string;
  description: string;
  requiredInputs: string[];
  sampleStory?: string;
  defaultAgents: string[];
  defaultModelAlias?: string;
  runtimePreference?: string;
  governancePreset?: string;
  runtimeRequirement?: string;
  templateCount: number;
  workflowTemplate: GalleryTemplate | null;
  templates: GalleryTemplate[];
};

export type GalleryData = {
  generatedAt?: string;
  items: GalleryItem[];
  referenceOnly: boolean;
  authRequired: boolean;
  message?: string;
};

export function normalizeGalleryResponse(value: unknown): GalleryData {
  const row = asRecord(value) ?? {};
  const items = rowsFrom(value, ["items", "intents", "templates", "data", "rows"])
    .map(normalizeGalleryItem)
    .filter((item): item is GalleryItem => Boolean(item));
  return {
    generatedAt: text(row.generatedAt ?? row.generated_at) || undefined,
    items,
    referenceOnly: bool(row.referenceOnly ?? row.reference_only, false),
    authRequired: bool(row.authRequired ?? row.auth_required, false),
    message: text(row.message) || undefined,
  };
}

export function filterGalleryItems(items: GalleryItem[], query: string): GalleryItem[] {
  const textQuery = query.trim().toLowerCase();
  if (!textQuery) return items;
  return items.filter((item) => [
    item.label,
    item.description,
    item.workflowTemplate?.name,
    item.defaultAgents.join(" "),
    item.requiredInputs.join(" "),
  ].join(" ").toLowerCase().includes(textQuery));
}

function normalizeGalleryItem(value: unknown, index: number): GalleryItem | null {
  const row = asRecord(value);
  if (!row) return null;
  const workflowTemplate = normalizeTemplate(row.workflowTemplate ?? row.workflow_template);
  const id = text(row.id ?? row.intent ?? row.key ?? workflowTemplate?.workflowTypeKey) || `intent-${index + 1}`;
  return {
    id,
    label: text(row.label ?? row.name) || id.replace(/_/g, " "),
    description: text(row.description ?? row.summary) || "Guided SDLC workflow.",
    requiredInputs: stringArray(row.requiredInputs ?? row.required_inputs),
    sampleStory: text(row.sampleStory ?? row.sample_story) || undefined,
    defaultAgents: stringArray(row.defaultAgents ?? row.default_agents),
    defaultModelAlias: text(row.defaultModelAlias ?? row.default_model_alias) || undefined,
    runtimePreference: text(row.runtimePreference ?? row.runtime_preference) || undefined,
    governancePreset: text(row.governancePreset ?? row.governance_preset) || undefined,
    runtimeRequirement: text(row.runtimeRequirement ?? row.runtime_requirement) || undefined,
    templateCount: positiveNumber(row.templateCount ?? row.template_count, workflowTemplate?.id ? 1 : 0),
    workflowTemplate,
    templates: rowsFrom(row.templates, ["templates"]).map(normalizeTemplate).filter((item): item is GalleryTemplate => Boolean(item)),
  };
}

function normalizeTemplate(value: unknown): GalleryTemplate | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = text(row.id ?? row.templateId ?? row.template_id);
  const name = text(row.name ?? row.displayName ?? row.display_name);
  if (!id && !name) return null;
  return {
    id: id || undefined,
    name: name || id,
    description: text(row.description) || undefined,
    workflowTypeKey: text(row.workflowTypeKey ?? row.workflow_type_key) || undefined,
    capabilityId: nullableText(row.capabilityId ?? row.capability_id),
  };
}

function rowsFrom(value: unknown, envelopeKeys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const row = asRecord(value);
  if (!row) return [];
  for (const key of envelopeKeys) {
    const candidate = row[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .map(text)
      .filter(Boolean)
      .slice(0, 20)
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return text(value) || null;
}

function positiveNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}
