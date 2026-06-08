import { describe, it, expect } from 'vitest'
import {
  extractJsonBlock,
  significantWords,
  jaccard,
  findDuplicatePairs,
  coverageGaps,
  flattenTasks,
  sanitizeMilestoneAssignments,
  parseConverse,
  parseCritic,
  priorityToWorkItem,
  milestoneEffortDays,
  totalEffortDays,
  aggregateUsage,
  type Milestone,
} from '../src/modules/planner/planner.service'

const milestone = (id: string, tasks: Array<{ title: string; description: string; capabilityId: string; effortDays?: number }>): Milestone => ({
  id,
  title: `Milestone ${id}`,
  summary: '',
  tasks: tasks.map((t) => ({ ...t, category: '', priority: 'MEDIUM', effortDays: t.effortDays ?? 1, aiSuggested: false })),
})

describe('extractJsonBlock', () => {
  it('pulls JSON out of a ```json fence', () => {
    expect(extractJsonBlock('prose\n```json\n{"a":1}\n```\nmore')).toBe('{"a":1}')
  })
  it('falls back to first{…last}', () => {
    expect(extractJsonBlock('here is { "a": 1 } ok')).toBe('{ "a": 1 }')
  })
})

describe('significantWords / jaccard', () => {
  it('drops stopwords and short tokens', () => {
    expect(significantWords('We need to build the login system')).toEqual(['login'])
  })
  it('jaccard identical=1, disjoint=0', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0)
  })
})

describe('flattenTasks', () => {
  it('flattens milestones into tasks tagged with their milestone', () => {
    const flat = flattenTasks([
      milestone('M1', [{ title: 'Schema', description: 'db schema', capabilityId: 'home' }]),
      milestone('M2', [{ title: 'Routing', description: 'route logic', capabilityId: 'child' }]),
    ])
    expect(flat).toHaveLength(2)
    expect(flat[0].milestone).toBe('Milestone M1')
    expect(flat[1].milestoneId).toBe('M2')
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
  it('returns goal words covered by no task', () => {
    const gaps = coverageGaps('Build login and an audit log', [{ title: 'Build login screen', description: 'login form' }])
    expect(gaps).toContain('audit')
    expect(gaps).not.toContain('login')
  })
})

describe('sanitizeMilestoneAssignments', () => {
  it('clamps unknown capability ids to home across milestones and counts repairs', () => {
    const res = sanitizeMilestoneAssignments(
      [
        milestone('M1', [
          { title: 'A', description: 'aa', capabilityId: 'home' },
          { title: 'B', description: 'bb', capabilityId: 'ghost' },
        ]),
        milestone('M2', [{ title: 'C', description: 'cc', capabilityId: 'child-1' }]),
      ],
      new Set(['home', 'child-1']),
      'home',
    )
    expect(res.repaired).toBe(1)
    expect(res.milestones[0].tasks[1].capabilityId).toBe('home')
    expect(res.milestones[1].tasks[0].capabilityId).toBe('child-1')
  })
})

describe('parseConverse', () => {
  it('parses a clarification turn', () => {
    const out = parseConverse('{"reply":"Need info","needsClarification":true,"questions":["Which currencies?"]}')
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.value.needsClarification).toBe(true)
      expect(out.value.questions).toEqual(['Which currencies?'])
      expect(out.value.milestones).toEqual([])
    }
  })
  it('parses a milestone plan with task defaults applied', () => {
    const raw = JSON.stringify({
      reply: 'done',
      milestones: [{ id: 'M1', title: 'Foundation', tasks: [{ title: 'Schema work', description: 'db schema', capabilityId: 'home' }] }],
    })
    const out = parseConverse(raw)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.value.milestones[0].tasks[0].priority).toBe('MEDIUM')
      expect(out.value.milestones[0].tasks[0].effortDays).toBe(1)
      expect(out.value.milestones[0].tasks[0].aiSuggested).toBe(false)
    }
  })
  it('rejects non-JSON', () => {
    expect(parseConverse('not json at all').ok).toBe(false)
  })
})

describe('parseCritic', () => {
  it('parses verdict + issues and defaults itemRef', () => {
    const c = parseCritic('{"verdict":"warn","issues":[{"dimension":"overlap","message":"x"}]}')
    expect(c.verdict).toBe('warn')
    expect(c.issues[0].itemRef).toBe('plan')
  })
  it('degrades to a manual-review warn on garbage', () => {
    const c = parseCritic('looks fine')
    expect(c.verdict).toBe('warn')
    expect(c.issues).toHaveLength(1)
  })
})

describe('effort rollup', () => {
  it('sums task effort per milestone and across the roadmap', () => {
    const ms = [
      milestone('M1', [
        { title: 'A', description: 'aa', capabilityId: 'home', effortDays: 2 },
        { title: 'B', description: 'bb', capabilityId: 'home', effortDays: 3 },
      ]),
      milestone('M2', [{ title: 'C', description: 'cc', capabilityId: 'home', effortDays: 1.5 }]),
    ]
    expect(milestoneEffortDays(ms[0])).toBe(5)
    expect(milestoneEffortDays(ms[1])).toBe(1.5)
    expect(totalEffortDays(ms)).toBe(6.5)
  })
})

describe('priorityToWorkItem', () => {
  it('maps display priority to urgency + number', () => {
    expect(priorityToWorkItem('HIGH')).toEqual({ urgency: 'HIGH', priority: 80 })
    expect(priorityToWorkItem('MEDIUM')).toEqual({ urgency: 'NORMAL', priority: 50 })
    expect(priorityToWorkItem('LOW')).toEqual({ urgency: 'LOW', priority: 30 })
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
