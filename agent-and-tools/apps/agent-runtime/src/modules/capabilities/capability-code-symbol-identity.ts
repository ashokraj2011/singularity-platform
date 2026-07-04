export type CapabilityCodeSymbolIdentityInput = {
  repositoryId: string;
  symbolHash?: string | null;
};

export function normalizedCodeSymbolValue(value?: string | null): string {
  return String(value ?? "").trim();
}

export function capabilityCodeSymbolKey(input: CapabilityCodeSymbolIdentityInput): string | null {
  const repositoryId = normalizedCodeSymbolValue(input.repositoryId);
  const symbolHash = normalizedCodeSymbolValue(input.symbolHash);
  if (!repositoryId || !symbolHash) return null;
  return `capability-code-symbol:${repositoryId.toLowerCase()}:${symbolHash.toLowerCase()}`;
}
