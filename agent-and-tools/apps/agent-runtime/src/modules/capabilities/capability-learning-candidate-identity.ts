import { createHash } from "crypto";

export type CapabilityLearningCandidateIdentityInput = {
  capabilityId: string;
  groupKey: string;
  artifactType: string;
  title: string;
  content: string;
  sourceType?: string | null;
  sourceRef?: string | null;
};

export function normalizedLearningCandidateIdentityValue(value?: string | null): string {
  return String(value ?? "").trim();
}

export function learningCandidateContentHash(content?: string | null): string {
  return createHash("sha256").update(String(content ?? "")).digest("hex");
}

export function capabilityLearningCandidateKey(input: CapabilityLearningCandidateIdentityInput): string | null {
  const capabilityId = normalizedLearningCandidateIdentityValue(input.capabilityId);
  const groupKey = normalizedLearningCandidateIdentityValue(input.groupKey);
  const artifactType = normalizedLearningCandidateIdentityValue(input.artifactType);
  const title = normalizedLearningCandidateIdentityValue(input.title);
  const content = String(input.content ?? "");
  if (!capabilityId || !groupKey || !artifactType || !title || !content.trim()) return null;
  return [
    "capability-learning-candidate",
    capabilityId.toLowerCase(),
    groupKey.toLowerCase(),
    artifactType.toLowerCase(),
    title.toLowerCase(),
    normalizedLearningCandidateIdentityValue(input.sourceType).toLowerCase(),
    normalizedLearningCandidateIdentityValue(input.sourceRef).toLowerCase(),
    learningCandidateContentHash(content),
  ].join(":");
}
