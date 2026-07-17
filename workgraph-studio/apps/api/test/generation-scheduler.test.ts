import { describe, expect, it } from 'vitest'
import { scheduleGenerationPlan } from '../src/modules/planning/generation-scheduler'

describe('generation plan scheduler', () => {
  it('creates a deterministic finish-to-start schedule and marks the longest path', () => {
    const schedule = scheduleGenerationPlan([
      { rowKey: 'design', estimatedHours: 8, dependencies: [] },
      { rowKey: 'api', estimatedHours: 16, dependencies: [{ rowKey: 'design' }] },
      { rowKey: 'ui', estimatedHours: 8, dependencies: [{ rowKey: 'design' }] },
      { rowKey: 'verify', estimatedHours: 4, dependencies: [{ rowKey: 'api' }, { rowKey: 'ui' }] },
    ], { startAt: new Date('2026-07-20T09:00:00.000Z'), hoursPerDay: 8 })

    const byKey = new Map(schedule.map(row => [row.rowKey, row]))
    expect(byKey.get('api')?.projectedStartAt).toEqual(byKey.get('design')?.projectedFinishAt)
    expect(byKey.get('verify')?.projectedStartAt).toEqual(byKey.get('api')?.projectedFinishAt)
    expect(byKey.get('design')?.criticalPath).toBe(true)
    expect(byKey.get('api')?.criticalPath).toBe(true)
    expect(byKey.get('verify')?.criticalPath).toBe(true)
    expect(byKey.get('ui')?.criticalPath).toBe(false)
  })

  it('skips weekends and rejects cycles', () => {
    const [row] = scheduleGenerationPlan([
      { rowKey: 'release', estimatedHours: 16, dependencies: [] },
    ], { startAt: new Date('2026-07-17T09:00:00.000Z'), hoursPerDay: 8 })
    expect(row.projectedFinishAt.toISOString()).toBe('2026-07-20T17:00:00.000Z')

    expect(() => scheduleGenerationPlan([
      { rowKey: 'a', estimatedHours: 1, dependencies: [{ rowKey: 'b' }] },
      { rowKey: 'b', estimatedHours: 1, dependencies: [{ rowKey: 'a' }] },
    ])).toThrow(/cycle/i)
  })

  it('uses capability calendars, skips holidays, and subtracts booked capacity', () => {
    const schedule = scheduleGenerationPlan([
      { rowKey: 'api', estimatedHours: 6, dependencies: [], capacityCalendarId: 'backend' },
    ], {
      startAt: new Date('2026-07-20T09:00:00.000Z'),
      capacityCalendars: [{
        id: 'backend',
        weeklyHours: { mon: 8, tue: 8, wed: 8, thu: 8, fri: 8 },
        holidays: ['2026-07-21'],
        allocations: [{
          startAt: new Date('2026-07-20T09:00:00.000Z'),
          endAt: new Date('2026-07-20T13:00:00.000Z'),
          estimatedHours: 4,
        }],
      }],
    })

    expect(schedule[0]).toMatchObject({ capacityCalendarId: 'backend', capacityConstrained: true })
    expect(schedule[0].projectedFinishAt.toISOString()).toBe('2026-07-22T11:00:00.000Z')
  })

  it('does not reset shared calendar capacity for a dependent task starting midday', () => {
    const schedule = scheduleGenerationPlan([
      { rowKey: 'design', estimatedHours: 4, dependencies: [], capacityCalendarId: 'team' },
      { rowKey: 'build', estimatedHours: 6, dependencies: [{ rowKey: 'design' }], capacityCalendarId: 'team' },
    ], {
      startAt: new Date('2026-07-20T09:00:00.000Z'),
      capacityCalendars: [{
        id: 'team',
        weeklyHours: { mon: 8, tue: 8, wed: 8, thu: 8, fri: 8 },
        holidays: [],
      }],
    })

    expect(schedule[0].projectedFinishAt.toISOString()).toBe('2026-07-20T13:00:00.000Z')
    expect(schedule[1].projectedStartAt.toISOString()).toBe('2026-07-20T13:00:00.000Z')
    expect(schedule[1].projectedFinishAt.toISOString()).toBe('2026-07-21T11:00:00.000Z')
  })
})
