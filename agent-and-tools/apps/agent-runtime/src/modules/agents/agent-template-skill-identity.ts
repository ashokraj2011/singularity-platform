export type AgentTemplateSkillIdentityInput = {
  agentTemplateId?: string | null;
  skillId?: string | null;
  sourceType?: string | null;
  sourceRef?: string | null;
  capabilityId?: string | null;
};

export function normalizedAgentTemplateSkillValue(value?: string | null): string {
  return String(value ?? "").trim();
}

export function agentTemplateSkillKey(input: AgentTemplateSkillIdentityInput): string | null {
  const agentTemplateId = normalizedAgentTemplateSkillValue(input.agentTemplateId);
  const skillId = normalizedAgentTemplateSkillValue(input.skillId);
  const sourceType = normalizedAgentTemplateSkillValue(input.sourceType);
  if (!agentTemplateId || !skillId || !sourceType) return null;
  return [
    "agent-template-skill",
    agentTemplateId.toLowerCase(),
    skillId.toLowerCase(),
    sourceType.toLowerCase(),
    normalizedAgentTemplateSkillValue(input.sourceRef).toLowerCase(),
    normalizedAgentTemplateSkillValue(input.capabilityId).toLowerCase(),
  ].join(":");
}
