/**
 * Unit tests for the Studio Board branch/fork pure helpers (PR-3) — the
 * exploration-budget math that gates agent sandboxes. DB-free.
 */
import { describe, it, expect } from 'vitest'
import { parseExplorationBudget, budgetExhausted } from '../src/modules/studio/board-branches'

describe('parseExplorationBudget', () => {
  it('reads valid caps and floors them', () => {
    expect(parseExplorationBudget({ maxEvents: 200.9, maxTurns: 8 })).toEqual({ maxEvents: 200, maxTurns: 8 })
  })
  it('drops non-positive / non-numeric / missing values', () => {
    expect(parseExplorationBudget({ maxEvents: 0, maxTurns: -3 })).toEqual({})
    expect(parseExplorationBudget({ maxEvents: 'lots' })).toEqual({})
    expect(parseExplorationBudget(null)).toEqual({})
    expect(parseExplorationBudget([1, 2])).toEqual({})
  })
})

describe('budgetExhausted', () => {
  it('trips at the event cap', () => {
    expect(budgetExhausted({ maxEvents: 100 }, 99)).toBe(false)
    expect(budgetExhausted({ maxEvents: 100 }, 100)).toBe(true)
    expect(budgetExhausted({ maxEvents: 100 }, 250)).toBe(true)
  })
  it('trips at the turn cap', () => {
    expect(budgetExhausted({ maxTurns: 5 }, 0, 5)).toBe(true)
    expect(budgetExhausted({ maxTurns: 5 }, 0, 4)).toBe(false)
  })
  it('never trips with no budget', () => {
    expect(budgetExhausted({}, 1_000_000, 1_000_000)).toBe(false)
  })
})
