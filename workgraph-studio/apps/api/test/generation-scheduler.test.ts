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
})
