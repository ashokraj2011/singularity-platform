/**
 * Synthesis Studio — the autonomy ladder (R1A Agents phase). PURE. An agent's ceiling
 * bounds what a turn may do; R1A NEVER auto-applies — material change always lands as a
 * PENDING proposal (L2), and a prohibited action is blocked even at a high ceiling. The
 * deny-list is absolute: these actions are always a human's, whatever the ladder says.
 */
export type AutonomyLevel = 'L0_ANSWER' | 'L1_DRAFT' | 'L2_PROPOSE' | 'L3_EXECUTE_REVERSIBLE' | 'L4_SCHEDULED'

export const LEVEL_RANK: Record<AutonomyLevel, number> = {
  L0_ANSWER: 0, L1_DRAFT: 1, L2_PROPOSE: 2, L3_EXECUTE_REVERSIBLE: 3, L4_SCHEDULED: 4,
}

// Never autonomous — always a human, regardless of an agent's ceiling.
export const PROHIBITED_AUTONOMOUS_ACTIONS: ReadonlySet<string> = new Set([
  'ACCEPT_DECISION', 'APPROVE_SPEC', 'CHANGE_BUDGET', 'CHANGE_OBJECTIVE',
  'APPLY_GENERATION_PLAN', 'COMPLETE_WORKITEM', 'DECLARE_OUTCOME', 'APPROVE_WAIVER', 'PUBLISH_READOUT',
])
export function isProhibitedAutonomous(action: string): boolean {
  return PROHIBITED_AUTONOMOUS_ACTIONS.has(action)
}

export type TurnDisposition =
  | { kind: 'ANSWER' } // L0: read-only, nothing persisted beyond the message
  | { kind: 'DRAFT' } // L1: a draft, no proposal
  | { kind: 'PROPOSE' } // L2+: material change persisted as a PENDING proposal
  | { kind: 'BLOCKED'; reason: string }

/**
 * Decide the disposition from the agent's ceiling, whether the turn produced material change,
 * and the actions it requested. A prohibited action blocks the turn even at L2+; otherwise
 * material change is capped at PROPOSE (never auto-applied in R1A).
 */
export function dispositionFor(ceiling: AutonomyLevel, producesMaterialChange: boolean, requestedActions: string[]): TurnDisposition {
  const prohibited = requestedActions.find(isProhibitedAutonomous)
  if (prohibited) return { kind: 'BLOCKED', reason: `${prohibited} is never autonomous — a human must perform it.` }
  if (!producesMaterialChange) return { kind: 'ANSWER' }
  if (LEVEL_RANK[ceiling] < LEVEL_RANK.L1_DRAFT) return { kind: 'BLOCKED', reason: 'agent ceiling is answer-only (L0)' }
  if (LEVEL_RANK[ceiling] < LEVEL_RANK.L2_PROPOSE) return { kind: 'DRAFT' }
  return { kind: 'PROPOSE' } // L2+ → PENDING proposal, never a direct mutation
}
