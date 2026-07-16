/**
 * Studio Board — branch/fork pure helpers (PR-3). The exploration-budget math is
 * pure so it unit-tests without the stack; the fork/materialize wiring that needs
 * the DB lives in board.service.ts.
 *
 * An AGENT_EXPLORATION branch is a sandbox a human opens with a stated purpose:
 * agents write directly (the whole branch is one big proposal), bounded by a
 * budget, and the branch auto-suspends when it runs out.
 */
export interface ExplorationBudget {
  maxEvents?: number
  maxTurns?: number
}

export function parseExplorationBudget(raw: unknown): ExplorationBudget {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: ExplorationBudget = {}
  if (typeof r.maxEvents === 'number' && Number.isFinite(r.maxEvents) && r.maxEvents > 0) out.maxEvents = Math.floor(r.maxEvents)
  if (typeof r.maxTurns === 'number' && Number.isFinite(r.maxTurns) && r.maxTurns > 0) out.maxTurns = Math.floor(r.maxTurns)
  return out
}

/** Exhausted once the branch hits its event (or turn) cap. No cap ⇒ never. */
export function budgetExhausted(budget: ExplorationBudget, eventCount: number, turnCount = 0): boolean {
  if (budget.maxEvents !== undefined && eventCount >= budget.maxEvents) return true
  if (budget.maxTurns !== undefined && turnCount >= budget.maxTurns) return true
  return false
}
