export type ProfileSkillBindingLike = {
  sourceType: string;
  skillId?: string | null;
  name?: string | null;
  description?: string | null;
  skillType?: string | null;
  promptLayerId?: string | null;
  sourceRef?: string | null;
  providerManifestUrl?: string | null;
  url?: string | null;
  fileName?: string | null;
  permissions?: string[] | null;
  readOnly?: boolean | null;
  providerLocked?: boolean | null;
  isDefault?: boolean | null;
  metadata?: Record<string, unknown> | null;
};

export function normalizedProfileBindingValue(value?: string | null): string {
  return String(value ?? "").trim();
}

export function uploadedFileNameKey(fileName?: string | null): string | null {
  const normalized = normalizedProfileBindingValue(fileName);
  return normalized ? normalized.toLowerCase() : null;
}

export function findDuplicateUploadedFileName(files: Array<{ originalname?: string | null }>): string | null {
  const seen = new Set<string>();
  for (const file of files) {
    const key = uploadedFileNameKey(file.originalname);
    if (!key) continue;
    if (seen.has(key)) return normalizedProfileBindingValue(file.originalname);
    seen.add(key);
  }
  return null;
}

export function profileBindingSourceRef(binding: {
  sourceRef?: string | null;
  providerManifestUrl?: string | null;
  url?: string | null;
  fileName?: string | null;
}): string {
  return normalizedProfileBindingValue(
    binding.sourceRef ?? binding.providerManifestUrl ?? binding.url ?? binding.fileName,
  );
}

export function profileSkillBindingKey(binding: ProfileSkillBindingLike): string | null {
  const sourceType = normalizedProfileBindingValue(binding.sourceType).toLowerCase();
  if (!sourceType) return null;

  const skillId = normalizedProfileBindingValue(binding.skillId);
  if (skillId) return `skill:${skillId.toLowerCase()}`;

  const sourceRef = profileBindingSourceRef(binding);
  if (sourceRef) return `source:${sourceType}:${sourceRef.toLowerCase()}`;

  const promptLayerId = normalizedProfileBindingValue(binding.promptLayerId);
  if (promptLayerId) return `prompt-layer:${sourceType}:${promptLayerId.toLowerCase()}`;

  if (sourceType === "local") {
    const skillType = normalizedProfileBindingValue(binding.skillType);
    const name = normalizedProfileBindingValue(binding.name);
    if (skillType || name) return `local:${skillType.toLowerCase()}:${name.toLowerCase()}`;
  }

  return null;
}

function mergePermissions(a?: string[] | null, b?: string[] | null): string[] | undefined {
  const values = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return values.length ? Array.from(new Set(values)) : undefined;
}

export function mergeProfileSkillBindings<T extends ProfileSkillBindingLike>(current: T, next: T): T {
  return {
    ...current,
    name: current.name ?? next.name,
    description: current.description ?? next.description,
    skillType: current.skillType ?? next.skillType,
    promptLayerId: current.promptLayerId ?? next.promptLayerId,
    sourceRef: current.sourceRef ?? next.sourceRef,
    providerManifestUrl: current.providerManifestUrl ?? next.providerManifestUrl,
    url: current.url ?? next.url,
    fileName: current.fileName ?? next.fileName,
    permissions: mergePermissions(current.permissions, next.permissions) as T["permissions"],
    readOnly: Boolean(current.readOnly || next.readOnly) as T["readOnly"],
    providerLocked: Boolean(current.providerLocked || next.providerLocked) as T["providerLocked"],
    isDefault: (current.isDefault ?? next.isDefault) as T["isDefault"],
    metadata: {
      ...(current.metadata ?? {}),
      ...(next.metadata ?? {}),
    } as T["metadata"],
  };
}

export function dedupeProfileSkillBindings<T extends ProfileSkillBindingLike>(bindings: T[]): T[] {
  const out: T[] = [];
  const indexByKey = new Map<string, number>();
  for (const binding of bindings) {
    const key = profileSkillBindingKey(binding);
    if (!key) {
      out.push(binding);
      continue;
    }
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, out.length);
      out.push(binding);
      continue;
    }
    out[existingIndex] = mergeProfileSkillBindings(out[existingIndex], binding);
  }
  return out;
}
