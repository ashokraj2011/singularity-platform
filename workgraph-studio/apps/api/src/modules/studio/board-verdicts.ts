/**
 * Studio Board — AgentVerdicts pure core (PR-5). Agents get VOICE, never VOTES: an
 * ENDORSE is evidence, a CHALLENGE is a standing question, a FLAG is a policy note —
 * none changes the status of a human artifact. This module holds the parse-time
 * contracts (citation rule + the tone contract) and the lifecycle state machine;
 * they're pure so they unit-test without the stack.
 */
import { z } from 'zod'

export const AGENT_ROLES = ['CONTRARIAN', 'SENTINEL', 'BLUEPRINT', 'PATHFINDER'] as const
export const VERDICT_STANCES = ['CHALLENGE', 'ENDORSE', 'FLAG'] as const
export const VERDICT_TARGET_TYPES = ['BOARD_OBJECT', 'CLAIM', 'REQUIREMENT', 'CONCEPT_CARD', 'DECISION', 'MOMENT'] as const

/**
 * Verdict input. Two parse-time guarantees:
 *  - Citation rule: evidenceRefs >= 1 — a verdict must ground itself.
 *  - Tone contract: a CHALLENGE must say what evidence would resolve it
 *    (resolvesWith), so it's answerable, not a nag. Rejected at parse otherwise.
 */
export const verdictBaseSchema = z.object({
  targetType: z.enum(VERDICT_TARGET_TYPES),
  targetRef: z.string().trim().min(1).max(200),
  stance: z.enum(VERDICT_STANCES),
  rationale: z.string().trim().min(1).max(1200),
  evidenceRefs: z.array(z.string().max(240)).min(1),
  resolvesWith: z.string().trim().max(600).optional(),
  confidence: z.number().min(0).max(1).default(0.6),
})
// The tone contract, applied to any verdict schema (base or the agent-extended one).
export const challengeToneRefine = (v: { stance: string; resolvesWith?: string }): boolean =>
  v.stance !== 'CHALLENGE' || !!v.resolvesWith?.trim()
export const challengeToneMessage = {
  message: 'A CHALLENGE must state what evidence would resolve it (resolvesWith).',
  path: ['resolvesWith'] as (string | number)[],
}
export const verdictInputSchema = verdictBaseSchema.refine(challengeToneRefine, challengeToneMessage)
export type VerdictInput = z.infer<typeof verdictBaseSchema>

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export const VERDICT_STATUSES = ['OPEN', 'ANSWERED', 'CONCEDED', 'DISMISSED', 'EXPIRED'] as const
export type VerdictStatus = (typeof VERDICT_STATUSES)[number]
export type VerdictAction = 'answer' | 'concede' | 'dismiss' | 'expire' | 'reopen'

const TRANSITIONS: Record<VerdictAction, { from: readonly VerdictStatus[]; to: VerdictStatus }> = {
  answer: { from: ['OPEN'], to: 'ANSWERED' }, // human attaches counter-evidence
  concede: { from: ['OPEN', 'ANSWERED'], to: 'CONCEDED' }, // agent re-evaluates and agrees
  dismiss: { from: ['OPEN', 'ANSWERED'], to: 'DISMISSED' }, // human dismisses (with a recorded reason)
  expire: { from: ['OPEN', 'ANSWERED'], to: 'EXPIRED' }, // decay policy
  reopen: { from: ['ANSWERED', 'DISMISSED', 'EXPIRED'], to: 'OPEN' },
}

/** The valid next status for an action, or null if the transition isn't allowed from `current`. */
export function nextVerdictStatus(current: VerdictStatus, action: VerdictAction): VerdictStatus | null {
  const t = TRANSITIONS[action]
  return t.from.includes(current) ? t.to : null
}

export function isTerminal(status: VerdictStatus): boolean {
  return status === 'CONCEDED' || status === 'DISMISSED' || status === 'EXPIRED'
}

/** ENDORSE contributes posterior evidence at the agent's tier (capped) — voice, not a vote. */
export const ENDORSE_EVIDENCE_TIER = 'AGENT' as const
