export type AgentSkillIdentityInput = {
  name?: string | null;
  skillType?: string | null;
  promptLayerId?: string | null;
};

export function normalizedAgentSkillIdentityValue(value?: string | null): string {
  return String(value ?? "").trim();
}

export function agentSkillKey(input: AgentSkillIdentityInput): string | null {
  const name = normalizedAgentSkillIdentityValue(input.name);
  const skillType = normalizedAgentSkillIdentityValue(input.skillType);
  if (!name || !skillType) return null;
  return [
    "agent-skill",
    skillType.toLowerCase(),
    name.toLowerCase(),
    normalizedAgentSkillIdentityValue(input.promptLayerId).toLowerCase(),
  ].join(":");
}
