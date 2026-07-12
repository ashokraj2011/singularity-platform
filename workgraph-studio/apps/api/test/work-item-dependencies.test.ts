import { describe, expect, it } from 'vitest'
import { dependencyGraphWouldCycle } from '../src/modules/work-items/work-item-dependencies.service'

describe('WorkItem dependencies', () => {
  it('rejects self and transitive cycles', () => {
    const edges = [{ predecessorId: 'a', successorId: 'b' }, { predecessorId: 'b', successorId: 'c' }]
    expect(dependencyGraphWouldCycle(edges, 'c', 'a')).toBe(true)
    expect(dependencyGraphWouldCycle(edges, 'a', 'a')).toBe(true)
  })

  it('allows a new edge that preserves a DAG', () => {
    expect(dependencyGraphWouldCycle([{ predecessorId: 'a', successorId: 'b' }], 'a', 'c')).toBe(false)
  })
})
