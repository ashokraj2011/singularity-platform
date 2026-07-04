export type CapabilityAgentBindingIdentityInput = {
  capabilityId: string;
  agentTemplateId: string;
};

export function normalizedBindingIdentityValue(value?: string | null): string {
  return String(value ?? "").trim();
}

export function capabilityAgentBindingKey(input: CapabilityAgentBindingIdentityInput): string | null {
  const capabilityId = normalizedBindingIdentityValue(input.capabilityId);
  const agentTemplateId = normalizedBindingIdentityValue(input.agentTemplateId);
  if (!capabilityId || !agentTemplateId) return null;
  return `capability-agent-binding:${capabilityId.toLowerCase()}:${agentTemplateId.toLowerCase()}`;
}
