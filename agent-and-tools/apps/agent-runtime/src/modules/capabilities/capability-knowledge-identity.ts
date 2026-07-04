export type CapabilityKnowledgeArtifactIdentityInput = {
  capabilityId: string;
  artifactType: string;
  title: string;
  sourceType?: string | null;
  sourceRef?: string | null;
};

export function normalizedKnowledgeIdentityValue(value?: string | null): string {
  return String(value ?? "").trim();
}

export function sourceBackedKnowledgeArtifactKey(input: CapabilityKnowledgeArtifactIdentityInput): string | null {
  const sourceRef = normalizedKnowledgeIdentityValue(input.sourceRef);
  if (!sourceRef) return null;
  return [
    "capability-knowledge",
    normalizedKnowledgeIdentityValue(input.capabilityId).toLowerCase(),
    normalizedKnowledgeIdentityValue(input.artifactType).toLowerCase(),
    normalizedKnowledgeIdentityValue(input.title).toLowerCase(),
    normalizedKnowledgeIdentityValue(input.sourceType).toLowerCase(),
    sourceRef.toLowerCase(),
  ].join(":");
}
