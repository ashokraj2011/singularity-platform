import { describe, it, expect } from 'vitest'
import {
  extractJsonBlock,
  significantWords,
  jaccard,
  findDuplicatePairs,
  coverageGaps,
  sanitizeAssignments,
  parsePlannerPlan,
  parseCritic,
  aggregateUsage,
  type PlannerItem,
} from '../src/modules/planner/planner.service'

const item = (over: Partial<PlannerItem>): PlannerItem => ({
  title: 'Title here',
  description: 'A description long enough to validate.',
  capabilityId: 'home',
  priority: 50,
  urgency: 'NORMAL',
  ...over,
})

describe('extractJsonBlock', () => {
  it('pulls JSON out of a ```json fence', () => {
    expect(extractJsonBlock('prose\n```json\n{"a":1}\n```\nmore')).toBe('{"a":1}')
  })
  it('pulls JSON out of a bare ``` fence', () => {
    expect(extractJsonBlock('```\n{"a":1}\n```')).toBe('{"a":1}')
  })
  it('falls back to first{…last}', () => {
    expect(extractJsonBlock('here is { "a": 1 } ok')).toBe('{ "a": 1 }')
  })
})

describe('significantWords / jaccard', () => {
  it('drops stopwords and short tokens', () => {
    expect(significantWords('We need to build the login system')).toEqual(['login'])
  })
  it('jaccard of identical sets is 1', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
  })
  it('jaccard of disjoint sets is 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0)
  })
})

describe('findDuplicatePairs', () => {
  it('flags near-identical items but not distinct ones', () => {
    const items = [
      { title: 'Implement password reset endpoint', description: 'Add reset password API route with token validation' },
      { title: 'Password reset endpoint implementation', description: 'reset password API route token validation added' },
      { title: 'Rate limit middleware', description: 'Add a throttling layer to public routes' },
    ]
    const pairs = findDuplicatePairs(items, 0.5)
    expect(pairs.some((p) => p.a === 0 && p.b === 1)).toBe(true)
    expect(pairs.some((p) => p.b === 2)).toBe(false)
  })
})

describe('coverageGaps', () => {
  it('returns goal words covered by no item', () => {
    const gaps = coverageGaps('Build login and an audit log', [{ title: 'Build login screen', description: 'login form' }])
    expect(gaps).toContain('audit')
    expect(gaps).not.toContain('login')
  })
})

describe('sanitizeAssignments', () => {
  it('clamps unknown capability ids to home and counts repairs', () => {
    const res = sanitizeAssignments(
      [item({ capabilityId: 'home' }), item({ capabilityId: 'ghost' }), item({ capabilityId: 'child-1' })],
      new Set(['home', 'child-1']),
      'home',
    )
    expect(res.repaired).toBe(1)
    expect(res.items[1].capabilityId).toBe('home')
    expect(res.items[2].capabilityId).toBe('child-1')
  })
})

describe('parsePlannerPlan', () => {
  it('parses a valid plan with defaults applied', () => {
    const raw = JSON.stringify({ items: [{ title: 'Do the thing', description: 'description long enough', capabilityId: 'home' }] })
    const out = parsePlannerPlan(raw)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.items[0].priority).toBe(50)
      expect(out.items[0].urgency).toBe('NORMAL')
    }
  })
  it('rejects an empty item list', () => {
    expect(parsePlannerPlan('{"items":[]}').ok).toBe(false)
  })
  it('rejects non-JSON', () => {
    expect(parsePlannerPlan('not json at all').ok).toBe(false)
  })
})

describe('parseCritic', () => {
  it('parses a verdict + issues and defaults itemRef', () => {
    const c = parseCritic('{"verdict":"warn","issues":[{"dimension":"overlap","message":"x"}]}')
    expect(c.verdict).toBe('warn')
    expect(c.issues[0].dimension).toBe('overlap')
    expect(c.issues[0].itemRef).toBe('plan')
  })
  it('degrades to a manual-review warn on garbage', () => {
    const c = parseCritic('the plan looks fine to me')
    expect(c.verdict).toBe('warn')
    expect(c.issues).toHaveLength(1)
  })
})

describe('aggregateUsage', () => {
  it('sums tokens/cost across calls and skips nulls', () => {
    const u = aggregateUsage([
      { usage: { inputTokens: 100, outputTokens: 50, estimatedCost: 0.01 } } as any,
      null,
      { usage: { inputTokens: 20, outputTokens: 10, estimatedCost: 0.002 } } as any,
    ])
    expect(u.inputTokens).toBe(120)
    expect(u.outputTokens).toBe(60)
    expect(u.estimatedCostUsd).toBeCloseTo(0.012, 4)
    expect(u.calls).toBe(2)
  })
})
