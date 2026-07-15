import { describe, expect, it } from 'vitest'
import { archiveAxesSchema } from '../src/modules/concept-archive/archive.schemas'
import { cellKeyOf, compositeScoreOf, considerInsertion, coverageOf, cosineSimilarity, dedupCheck, dedupCheckWithEmbeddings, pathfinderRank } from '../src/modules/concept-archive/archive.engine'

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

  it('uses embeddings when available and keeps lexical fallback deterministic', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(dedupCheckWithEmbeddings('unrelated words', [1, 0], [{ text: 'different words', embedding: [1, 0] }]).method).toBe('embedding')
    expect(dedupCheckWithEmbeddings('secure checkout', undefined, [{ text: 'secure checkout flow' }], { lexicalThreshold: 0.5 }).duplicate).toBe(true)
  })

  it('bounds Pathfinder expansion and ranks matched terms before score ties', () => {
    const cards = Array.from({ length: 20 }, (_, index) => ({
      id: `card-${index}`,
      title: index === 0 ? 'Support cost reduction' : `Idea ${index}`,
      summary: index === 0 ? 'Reduce support cost with guided self service' : 'Other idea',
      status: 'STAGED',
      compositeScore: index === 0 ? 0.2 : -1,
    }))
    const result = pathfinderRank('support cost', cards, { maxResults: 5, maxExpansions: 3 })
    expect(result.expansions).toBe(3)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].card.id).toBe('card-0')
    expect(result.results[0].matchedTerms).toEqual(['support', 'cost'])
  })
})
