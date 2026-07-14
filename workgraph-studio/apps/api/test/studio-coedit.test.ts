import { describe, it, expect } from 'vitest'
import { appendUpdates, updatesSince, headSeq, type CoeditEntry } from '../src/modules/studio/coedit'

describe('coedit relay log', () => {
  it('appendUpdates assigns monotonic seqs and preserves the existing log', () => {
    const a = appendUpdates([], ['u1', 'u2'])
    expect(a).toEqual([{ seq: 1, update: 'u1' }, { seq: 2, update: 'u2' }])
    const b = appendUpdates(a, ['u3'])
    expect(b.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(b[2]).toEqual({ seq: 3, update: 'u3' })
  })

  it('updatesSince returns only entries past the high-water seq', () => {
    const log: CoeditEntry[] = [
      { seq: 1, update: 'a' }, { seq: 2, update: 'b' }, { seq: 3, update: 'c' },
    ]
    expect(updatesSince(log, 0).map((e) => e.seq)).toEqual([1, 2, 3])
    expect(updatesSince(log, 2).map((e) => e.seq)).toEqual([3])
    expect(updatesSince(log, 3)).toEqual([])
  })

  it('headSeq is the last seq, or 0 for an empty log', () => {
    expect(headSeq([])).toBe(0)
    expect(headSeq([{ seq: 7, update: 'x' }])).toBe(7)
  })
})
