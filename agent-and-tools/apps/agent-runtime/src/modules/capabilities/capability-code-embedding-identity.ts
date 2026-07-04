export type CapabilityCodeEmbeddingIdentityInput = {
  symbolId?: string | null;
};

export function normalizedCodeEmbeddingValue(value?: string | null): string {
  return String(value ?? "").trim();
}

export function capabilityCodeEmbeddingKey(input: CapabilityCodeEmbeddingIdentityInput): string | null {
  const symbolId = normalizedCodeEmbeddingValue(input.symbolId);
  if (!symbolId) return null;
  return `capability-code-embedding:${symbolId.toLowerCase()}`;
}
