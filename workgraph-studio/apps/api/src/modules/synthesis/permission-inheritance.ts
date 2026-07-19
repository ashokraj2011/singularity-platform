/**
 * Synthesis Studio — permission inheritance (R1A Agents phase). PURE. An agent's effective
 * capability is the INTERSECTION of the human's permissions, the agent role's allowed tools,
 * and any resource/tenant policy allow-list. Empty intersection ⇒ the agent may mutate
 * nothing. Enforced at two points: pre-turn (shape the allowed-tool set) and at-apply
 * (the proposal apply-registry re-checks).
 */
export function effectiveTools(humanAllowed: string[], agentRoleTools: string[], policyAllowed?: string[]): string[] {
  const human = new Set(humanAllowed)
  const policy = policyAllowed ? new Set(policyAllowed) : null
  return agentRoleTools.filter((t) => human.has(t) && (!policy || policy.has(t)))
}

export function toolAllowed(tool: string, humanAllowed: string[], agentRoleTools: string[], policyAllowed?: string[]): boolean {
  return effectiveTools(humanAllowed, agentRoleTools, policyAllowed).includes(tool)
}
