/**
 * Synthesis Studio — agent registry (R1A Agents phase). The three first agents differ only
 * in persona, capability, allowed proposal-item verbs, and autonomy ceiling. Config in code
 * (like loop strategies); a per-workspace override table is a follow-on. All ceiling at
 * L2_PROPOSE in R1A — nothing auto-applies.
 */
import type { AutonomyLevel } from '../autonomy'

export type AgentRole = 'FACILITATOR' | 'EVIDENCE_CURATOR' | 'REQUIREMENTS_EDITOR'

export interface AgentConfig {
  role: AgentRole
  displayName: string
  capabilityId: string | null
  autonomyCeiling: AutonomyLevel
  allowedTools: string[]
  persona: string
}

export const AGENT_REGISTRY: Record<AgentRole, AgentConfig> = {
  FACILITATOR: {
    role: 'FACILITATOR',
    displayName: 'Synthesis Facilitator',
    capabilityId: null,
    autonomyCeiling: 'L2_PROPOSE',
    allowedTools: ['EDIT_DOC_BLOCK', 'ADD_DOC_BLOCK'],
    persona:
      'You are the Synthesis Facilitator. You frame the initiative, ask clarifying questions, and draft and coordinate documents. You never decide on a human\'s behalf: propose changes as reviewable items with citations, and never approve, publish, or complete anything.',
  },
  EVIDENCE_CURATOR: {
    role: 'EVIDENCE_CURATOR',
    displayName: 'Evidence Curator',
    capabilityId: null,
    autonomyCeiling: 'L2_PROPOSE',
    allowedTools: ['PROPOSE_CLAIM', 'FLAG_CONTRADICTION', 'ADD_DOC_BLOCK'],
    persona:
      'You are the Evidence Curator. You process source material, propose claims (each with a human steward and a cited source), surface contradictions as challenges (voice, not vote), and assess evidence quality and gaps. Never assert a claim as settled truth.',
  },
  REQUIREMENTS_EDITOR: {
    role: 'REQUIREMENTS_EDITOR',
    displayName: 'Requirements Editor',
    capabilityId: null,
    autonomyCeiling: 'L2_PROPOSE',
    allowedTools: ['ADD_REQUIREMENT', 'REVISE_REQUIREMENT', 'ADD_ACCEPTANCE', 'EDIT_DOC_BLOCK'],
    persona:
      'You are the Requirements Editor. You draft and refine PRDs/BRDs — requirements and acceptance criteria — improving testability and surfacing ambiguity and missing edge cases. You produce tracked changes as reviewable items; you never approve a specification.',
  },
}

export function agentConfig(role: string): AgentConfig | null {
  return (AGENT_REGISTRY as Record<string, AgentConfig>)[role] ?? null
}
