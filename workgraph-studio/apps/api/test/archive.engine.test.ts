import { describe, expect, it } from 'vitest'
import { archiveAxesSchema } from '../src/modules/concept-archive/archive.schemas'
import { cellKeyOf, compositeScoreOf, considerInsertion, coverageOf, dedupCheck } from '../src/modules/concept-archive/archive.engine'

const axes = archiveAxesSchema.parse([
  { key: 'novelty', bins: ['low', 'high'] },
  { key: 'feasibility', bins: ['low', 'high'] },
])

describe('concept archive engine', () => {
  it('creates stable keys in declared axis order', () => {
    expect(cellKeyOf(axes, { feasibility: 'high', novelty: 'low' })).toBe('novelty=low|feasibility=high')
    expect(() => cellKeyOf(axes, { novelty: 'unknown', feasibility: 'high' })).toThrow()
  })

  it('keeps human and pinned cards sovereign', () => {
    expect(considerInsertion({ elite: { authorType: 'HUMAN', compositeScore: 0.2 } }, { authorType: 'AGENT', compositeScore: 0.99 }).kind).toBe('PROPOSE_SWAP')
    expect(considerInsertion({ elite: { authorType: 'AGENT', compositeScore: 0.2, pinned: true } }, { authorType: 'AGENT', compositeScore: 0.99 }).kind).toBe('KEEP_ELITE')
    expect(considerInsertion({ elite: { authorType: 'AGENT', compositeScore: 0.2 } }, { authorType: 'AGENT', compositeScore: 0.4 }).kind).toBe('PLACE_ELITE')
  })

  it('scores fitness transparently and reports sparse coverage', () => {
    expect(compositeScoreOf({ value: 1 }, { value: 1 })).toBeGreaterThan(0.7)
    const result = coverageOf(axes, [{ cellKey: 'novelty=low|feasibility=low', eliteCardId: 'c1' }, { cellKey: 'novelty=high|feasibility=high', killed: true }])
    expect(result.totalCells).toBe(4)
    expect(result.occupiedCells).toBe(1)
    expect(result.killedCells).toBe(1)
    expect(result.emptyCells).toBe(2)
  })

  it('detects close lexical duplicates without coupling persistence', () => {
    expect(dedupCheck('secure checkout', ['secure checkout flow'], 0.5).duplicate).toBe(true)
    expect(dedupCheck('mobile analytics dashboard', ['secure checkout flow']).duplicate).toBe(false)
  })
})
