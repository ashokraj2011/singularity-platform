/**
 * Unit tests for the per-stage workbench budget helper (SOFT / WARN_ONLY).
 */
import { describe, it, expect } from 'vitest'
import { evaluateStageBudget, readStageBudget } from '../src/modules/blueprint/stage-budget'

describe('readStageBudget', () => {
  it('parses a valid USD budget with default warn%', () => {
    expect(readStageBudget({ unit: 'USD', amount: 5 })).toEqual({ unit: 'USD', amount: 5, warnAtPercent: 80 })
  })
  it('parses tokens + clamps warn%', () => {
    expect(readStageBudget({ unit: 'TOKENS', amount: 100_000, warnAtPercent: 150 })).toEqual({ unit: 'TOKENS', amount: 100_000, warnAtPercent: 100 })
  })
  it('rejects missing/invalid config', () => {
    expect(readStageBudget(null)).toBeNull()
    expect(readStageBudget({ unit: 'EUR', amount: 5 })).toBeNull()
    expect(readStageBudget({ unit: 'USD', amount: 0 })).toBeNull()
    expect(readStageBudget({ unit: 'USD' })).toBeNull()
  })
})

describe('evaluateStageBudget — TOKENS', () => {
  const cfg = { unit: 'TOKENS' as const, amount: 100, warnAtPercent: 80 }
  it('ok below warn threshold', () => {
    expect(evaluateStageBudget(cfg, { tokens: 50, usd: null }).level).toBe('ok')
  })
  it('warn at/over warn% but under amount', () => {
    const r = evaluateStageBudget(cfg, { tokens: 85, usd: null })
    expect(r.level).toBe('warn')
    expect(r.percent).toBe(85)
  })
  it('exceeded at/over amount', () => {
    expect(evaluateStageBudget(cfg, { tokens: 100, usd: null }).level).toBe('exceeded')
    expect(evaluateStageBudget(cfg, { tokens: 130, usd: null }).level).toBe('exceeded')
  })
})

describe('evaluateStageBudget — USD', () => {
  const cfg = { unit: 'USD' as const, amount: 2, warnAtPercent: 75 }
  it('warns/exceeds on priced spend', () => {
    expect(evaluateStageBudget(cfg, { tokens: 0, usd: 1.0 }).level).toBe('ok')
    expect(evaluateStageBudget(cfg, { tokens: 0, usd: 1.6 }).level).toBe('warn')
    expect(evaluateStageBudget(cfg, { tokens: 0, usd: 2.5 }).level).toBe('exceeded')
  })
  it('never warns when unpriced (usd unknown)', () => {
    const r = evaluateStageBudget(cfg, { tokens: 9_999_999, usd: null })
    expect(r.level).toBe('ok')
    expect(r.priced).toBe(false)
  })
})
