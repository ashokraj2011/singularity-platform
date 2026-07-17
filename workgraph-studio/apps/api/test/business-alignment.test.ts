import { describe, expect, it } from 'vitest'
import {
  buildValueDeliveredCurve,
  diffRequirements,
  deriveMilestoneStatus,
  detectObjectiveCoverage,
  maxObjectiveValueScore,
  previousCompleteUtcWeek,
  uncoveredRequirementDelta,
} from '../src/modules/business-alignment/business-alignment'
import { scheduleGenerationPlan } from '../src/modules/planning/generation-scheduler'

const objectives = [
  { id: 'objective-1', title: 'Reduce settlement time', status: 'ACTIVE', valueScore: 5 },
  { id: 'objective-2', title: 'Reduce support cost', status: 'ACTIVE', valueScore: 3 },
]

describe('business objective coverage', () => {
  it('blocks MUST work without funded intent and warns for lower priorities', () => {
    const result = detectObjectiveCoverage(objectives, [
      { id: 'REQ-1', statement: 'Settle refunds quickly', priority: 'MUST', objectiveRefs: [] },
      { id: 'REQ-2', statement: 'Polish the timeline', priority: 'SHOULD', objectiveRefs: [] },
    ], 'lock')

    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REQUIREMENT_WITHOUT_OBJECTIVE', entityId: 'REQ-1' })]))
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REQUIREMENT_WITHOUT_OBJECTIVE', entityId: 'REQ-2' })]))
  })

  it('finds funded intent with no work and rejects unknown objective references', () => {
    const result = detectObjectiveCoverage(objectives, [
      { id: 'REQ-1', statement: 'Settle refunds quickly', priority: 'MUST', objectiveRefs: ['objective-1', 'missing-objective'] },
    ], 'portfolio')

    expect(result.errors.map(issue => issue.code)).toContain('ACTIVE_OBJECTIVE_UNSERVED')
    expect(result.errors.map(issue => issue.code)).toContain('UNKNOWN_OBJECTIVE_REFERENCE')
    expect(result.coveragePercent).toBe(50)
  })

  it('uses the strongest served objective as the row value', () => {
    expect(maxObjectiveValueScore(['objective-1', 'objective-2'], new Map(objectives.map(item => [item.id, item.valueScore])))).toBe(5)
  })
})

describe('derived business delivery status', () => {
  const now = new Date('2026-08-10T09:00:00.000Z')

  it('derives milestone states rather than trusting a hand-entered status', () => {
    expect(deriveMilestoneStatus({ targetDate: new Date('2026-08-20T00:00:00.000Z'), completed: 2, total: 2, now })).toBe('DELIVERED')
    expect(deriveMilestoneStatus({ targetDate: new Date('2026-08-20T00:00:00.000Z'), projectedFinishAt: new Date('2026-08-25T00:00:00.000Z'), completed: 0, total: 2, now })).toBe('AT_RISK')
    expect(deriveMilestoneStatus({ targetDate: new Date('2026-08-01T00:00:00.000Z'), completed: 0, total: 2, now })).toBe('LATE')
  })

  it('builds a cumulative value-delivered-by-date curve', () => {
    const curve = buildValueDeliveredCurve([
      { rowKey: 'lower', projectedFinishAt: new Date('2026-08-12T00:00:00.000Z'), objectiveValueScore: 2 },
      { rowKey: 'higher', projectedFinishAt: new Date('2026-08-11T00:00:00.000Z'), objectiveValueScore: 5 },
    ])
    expect(curve.map(point => point.cumulativeValue)).toEqual([5, 7])
  })

  it('uses a stable previous UTC week for retry-safe weekly readouts', () => {
    const monday = previousCompleteUtcWeek(new Date('2026-07-13T08:00:00.000Z'))
    const fridayRetry = previousCompleteUtcWeek(new Date('2026-07-17T22:14:00.000Z'))
    expect(monday.periodStart.toISOString()).toBe('2026-07-06T00:00:00.000Z')
    expect(monday.periodEnd.toISOString()).toBe('2026-07-13T00:00:00.000Z')
    expect(fridayRetry).toEqual(monday)
  })

  it('requires an approved change request to cover every actual requirement delta', () => {
    const actual = diffRequirements(
      [{ id: 'REQ-1', statement: 'old' }, { id: 'REQ-2', statement: 'remove' }],
      [{ id: 'REQ-1', statement: 'new' }, { id: 'REQ-3', statement: 'add' }],
    )
    expect(actual).toEqual({ added: ['REQ-3'], changed: ['REQ-1'], removed: ['REQ-2'] })
    expect(uncoveredRequirementDelta(actual, { added: ['REQ-3'], changed: [], removed: ['REQ-2'] })).toEqual(['REQ-1'])
    expect(uncoveredRequirementDelta(actual, actual)).toEqual([])
  })

  it('schedules independent work on shared capacity by business value first', () => {
    const schedule = scheduleGenerationPlan([
      { rowKey: 'low-value', estimatedHours: 4, dependencies: [], capacityCalendarId: 'team', valueScore: 1 },
      { rowKey: 'high-value', estimatedHours: 4, dependencies: [], capacityCalendarId: 'team', valueScore: 5 },
    ], {
      startAt: new Date('2026-08-10T09:00:00.000Z'),
      capacityCalendars: [{ id: 'team', weeklyHours: { mon: 8, tue: 8, wed: 8, thu: 8, fri: 8 }, holidays: [] }],
    })
    expect(schedule.map(row => row.rowKey)).toEqual(['high-value', 'low-value'])
    expect(schedule[1].projectedStartAt).toEqual(schedule[0].projectedFinishAt)
  })
})
