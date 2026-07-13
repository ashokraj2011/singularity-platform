import { describe, it, expect } from 'vitest'
import { tallyByStatus } from '../src/modules/reconciliations/reconciliation-overview.service'

describe('tallyByStatus', () => {
  it('folds prisma groupBy rows into a { total, byStatus } tally', () => {
    const r = tallyByStatus([
      { status: 'PASSED', _count: 3 },
      { status: 'FAILED', _count: 1 },
      { status: 'PARTIAL', _count: 2 },
    ])
    expect(r.total).toBe(6)
    expect(r.byStatus).toEqual({ PASSED: 3, FAILED: 1, PARTIAL: 2 })
  })

  it('supports the object _count shape and an empty set', () => {
    expect(tallyByStatus([{ status: 'RECEIVED', _count: { _all: 4 } }])).toEqual({ total: 4, byStatus: { RECEIVED: 4 } })
    expect(tallyByStatus([])).toEqual({ total: 0, byStatus: {} })
  })
})
