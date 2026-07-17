import { afterEach, describe, it, expect, vi } from 'vitest'
import { createProjectSchema, updateProjectSchema, archiveProjectSchema } from '../src/modules/studio/studio-projects.router'
import { shapeProject } from '../src/modules/studio/studio-projects.service'

describe('studio project schemas', () => {
  it('requires a name and primary IAM capability, then supplies portfolio defaults', () => {
    const parsed = createProjectSchema.safeParse({ name: 'Payments Reliability', primaryCapabilityId: 'payments' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.tokenBudget).toBe(250_000)
      expect(parsed.data.reviewCadenceDays).toBe(30)
      expect(parsed.data.impactedCapabilityIds).toEqual([])
    }
    expect(createProjectSchema.safeParse({ name: 'Payments Reliability' }).success).toBe(false)
    expect(createProjectSchema.safeParse({ name: '  ' }).success).toBe(false)
    expect(createProjectSchema.safeParse({ mission: 'no name' }).success).toBe(false)
  })

  it('rejects meaningless budgets and out-of-range value or risk scores', () => {
    const base = { name: 'Payments Reliability', primaryCapabilityId: 'payments' }
    expect(createProjectSchema.safeParse({ ...base, tokenBudget: 9_999 }).success).toBe(false)
    expect(createProjectSchema.safeParse({ ...base, businessValue: 6 }).success).toBe(false)
    expect(createProjectSchema.safeParse({ ...base, deliveryRisk: 0 }).success).toBe(false)
    expect(createProjectSchema.safeParse({ ...base, impactedCapabilityIds: Array.from({ length: 9 }, (_, index) => `cap-${index}`) }).success).toBe(false)
  })

  it('updateProjectSchema allows a partial patch and a null mission (clear it)', () => {
    expect(updateProjectSchema.safeParse({}).success).toBe(true)
    expect(updateProjectSchema.safeParse({ mission: null }).success).toBe(true)
    expect(updateProjectSchema.safeParse({ name: 'Renamed' }).success).toBe(true)
  })

  it('archiveProjectSchema defaults archived to true', () => {
    expect(archiveProjectSchema.parse({})).toEqual({ archived: true })
    expect(archiveProjectSchema.parse({ archived: false })).toEqual({ archived: false })
  })
})

describe('shapeProject', () => {
  afterEach(() => vi.useRealTimers())

  it('adds portfolio scores, budget burn, aging, and claim counts', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'))
    const shaped = shapeProject({
      id: 'p1',
      code: 'PRJ-ABCDE',
      name: 'X',
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      targetDate: new Date('2026-07-01T00:00:00.000Z'),
      reviewCadenceDays: 30,
      businessValue: 5,
      customerImpact: 4,
      strategicAlignment: 4,
      urgency: 3,
      deliveryRisk: 4,
      technicalRisk: 3,
      regulatoryRisk: 2,
      confidence: 4,
      effort: 2,
      tokenBudget: 100_000,
      tokenUsed: 25_000,
      claims: [],
      workItems: [],
      impactAssessments: [{ status: 'COMPLETED', updatedAt: new Date('2026-06-01T00:00:00.000Z') }],
      _count: { workItems: 4, claims: 7 },
    })
    expect(shaped).toMatchObject({
      workItemCount: 4,
      claimCount: 7,
      ageDays: 76,
      inactiveDays: 45,
      agingStatus: 'OVERDUE',
      valueScore: 4,
      riskScore: 3,
      priorityScore: 1,
      tokenBudgetPercent: 25,
      impactAssessmentStatus: 'COMPLETED',
    })
    expect('_count' in shaped).toBe(false)
  })
})
