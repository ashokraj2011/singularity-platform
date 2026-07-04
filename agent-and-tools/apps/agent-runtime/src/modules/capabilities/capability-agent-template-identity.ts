export type CapabilityAgentTemplateIdentityInput = {
  capabilityId?: string | null;
  name?: string | null;
};

export function normalizedAgentTemplateIdentityValue(value?: string | null): string {
  return String(value ?? "").trim();
}

export function normalizedAgentTemplateName(value?: string | null): string {
  return normalizedAgentTemplateIdentityValue(value);
}

export function capabilityAgentTemplateKey(input: CapabilityAgentTemplateIdentityInput): string | null {
  const capabilityId = normalizedAgentTemplateIdentityValue(input.capabilityId);
  const name = normalizedAgentTemplateName(input.name);
  if (!capabilityId || !name) return null;
  return `capability-agent-template:${capabilityId.toLowerCase()}:${name.toLowerCase()}`;
}
