import { describe, it, expect } from 'vitest'
import { evaluatePredicate } from '../src/modules/workflow/runtime/executors/governance/evalPredicate'

const ctx = { metrics: { coverage: 0.92 }, flags: { released: true }, name: 'x' }

describe('evaluatePredicate (CUSTOM_EXPRESSION safe predicate)', () => {
  it('truthy (default op) on a dot-path', () => {
    expect(evaluatePredicate(ctx, { path: 'flags.released' })).toBe(true)
    expect(evaluatePredicate(ctx, { path: 'flags.missing' })).toBe(false)
  })
  it('exists', () => {
    expect(evaluatePredicate(ctx, { path: 'name', op: 'exists' })).toBe(true)
    expect(evaluatePredicate(ctx, { path: 'nope', op: 'exists' })).toBe(false)
  })
  it('eq / ne', () => {
    expect(evaluatePredicate(ctx, { path: 'name', op: 'eq', value: 'x' })).toBe(true)
    expect(evaluatePredicate(ctx, { path: 'name', op: 'ne', value: 'y' })).toBe(true)
  })
  it('numeric comparisons', () => {
    expect(evaluatePredicate(ctx, { path: 'metrics.coverage', op: 'gte', value: 0.9 })).toBe(true)
    expect(evaluatePredicate(ctx, { path: 'metrics.coverage', op: 'gt', value: 0.95 })).toBe(false)
    expect(evaluatePredicate(ctx, { path: 'metrics.coverage', op: 'lt', value: 1 })).toBe(true)
  })
  it('non-numeric values never satisfy numeric ops', () => {
    expect(evaluatePredicate(ctx, { path: 'name', op: 'gt', value: 0 })).toBe(false)
  })
  it('empty/invalid path is false', () => {
    expect(evaluatePredicate(ctx, { path: '' })).toBe(false)
  })
})
