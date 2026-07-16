import { describe, expect, it } from 'vitest'
import { synthesizeBoardObjects } from '../src/modules/studio/board-synthesis'

describe('synthesizeBoardObjects', () => {
  const objects = [
    { id: 'u1', type: 'sticky', text: 'Users need a faster approval experience' },
    { id: 'u2', type: 'sticky', text: 'Customer adoption is blocked by manual approval handoffs' },
    { id: 't1', type: 'sticky', text: 'The API could automate workflow routing but security is a concern' },
    { id: 'edge', type: 'connector', sourceId: 'u1', targetId: 'u2' },
  ]

  it('creates source-linked themes and excludes structural objects', () => {
    const result = synthesizeBoardObjects(objects)
    expect(result.sourceCount).toBe(3)
    expect(result.coverage).toBe(1)
    expect(result.themes.length).toBeGreaterThan(0)
    expect(result.themes.flatMap(theme => theme.sourceIds)).not.toContain('edge')
  })

  it('surfaces tensions and opportunities independently', () => {
    const result = synthesizeBoardObjects(objects)
    expect(result.tensions.some(item => item.sourceIds.includes('t1'))).toBe(true)
    expect(result.opportunities.some(item => item.sourceIds.includes('u1'))).toBe(true)
  })

  it('respects an explicit selection', () => {
    const result = synthesizeBoardObjects(objects, { objectIds: ['u1'] })
    expect(result.sourceCount).toBe(1)
    expect(result.themes.flatMap(theme => theme.sourceIds)).toEqual(['u1'])
  })

  it('honors a human-selected category before keyword inference', () => {
    const result = synthesizeBoardObjects([{ id: 'm1', type: 'sticky', category: 'MARKET', text: 'A deliberately ambiguous thought' }])
    expect(result.themes[0]?.title).toBe('Market signal')
  })

  it('returns actionable guidance for an empty board', () => {
    const result = synthesizeBoardObjects([])
    expect(result.sourceCount).toBe(0)
    expect(result.warnings[0]).toMatch(/Add at least one text note/)
  })
})
