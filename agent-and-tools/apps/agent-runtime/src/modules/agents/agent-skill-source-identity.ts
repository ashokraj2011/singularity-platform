export type AgentSkillSourceIdentityInput = {
  skillId?: string | null;
  sourceType?: string | null;
  sourceRef?: string | null;
  capabilityId?: string | null;
};

export function normalizedAgentSkillSourceValue(value?: string | null): string {
  return String(value ?? "").trim();
}

export function agentSkillSourceKey(input: AgentSkillSourceIdentityInput): string | null {
  const skillId = normalizedAgentSkillSourceValue(input.skillId);
  const sourceType = normalizedAgentSkillSourceValue(input.sourceType);
  if (!skillId || !sourceType) return null;
  return [
    "agent-skill-source",
    skillId.toLowerCase(),
    sourceType.toLowerCase(),
    normalizedAgentSkillSourceValue(input.sourceRef).toLowerCase(),
    normalizedAgentSkillSourceValue(input.capabilityId).toLowerCase(),
  ].join(":");
}
