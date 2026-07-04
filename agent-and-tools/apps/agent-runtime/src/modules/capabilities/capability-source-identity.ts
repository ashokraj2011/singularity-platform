export type CapabilityRepositoryIdentityInput = {
  capabilityId: string;
  repoUrl: string;
  defaultBranch?: string | null;
  repositoryType?: string | null;
};

export type CapabilityKnowledgeSourceIdentityInput = {
  capabilityId: string;
  url: string;
  artifactType?: string | null;
};

export function normalizedSourceValue(value?: string | null): string {
  return String(value ?? "").trim();
}

export function normalizedRepositoryBranch(value?: string | null): string {
  return normalizedSourceValue(value) || "main";
}

export function normalizedRepositoryType(value?: string | null): string {
  return normalizedSourceValue(value) || "GITHUB";
}

export function normalizedKnowledgeArtifactType(value?: string | null): string {
  return normalizedSourceValue(value) || "DOC";
}

export function capabilityRepositorySourceKey(input: CapabilityRepositoryIdentityInput): string | null {
  const repoUrl = normalizedSourceValue(input.repoUrl);
  if (!repoUrl) return null;
  return [
    "capability-repository",
    normalizedSourceValue(input.capabilityId).toLowerCase(),
    repoUrl.toLowerCase(),
    normalizedRepositoryBranch(input.defaultBranch).toLowerCase(),
    normalizedRepositoryType(input.repositoryType).toLowerCase(),
  ].join(":");
}

export function capabilityKnowledgeSourceKey(input: CapabilityKnowledgeSourceIdentityInput): string | null {
  const url = normalizedSourceValue(input.url);
  if (!url) return null;
  return [
    "capability-knowledge-source",
    normalizedSourceValue(input.capabilityId).toLowerCase(),
    url.toLowerCase(),
    normalizedKnowledgeArtifactType(input.artifactType).toLowerCase(),
  ].join(":");
}
