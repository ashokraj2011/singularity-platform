import { describe, it, expect } from 'vitest'
import { pruneStale, upsertBeat, PRESENCE_TTL_MS, type PresenceBeat } from '../src/modules/studio/presence'

const beat = (userId: string, at: number, surface?: string): PresenceBeat => ({ userId, at, surface })

describe('pruneStale', () => {
  it('keeps fresh heartbeats and drops ones past the TTL', () => {
    const now = 1_000_000
    const entries = [beat('a', now), beat('b', now - PRESENCE_TTL_MS + 1), beat('c', now - PRESENCE_TTL_MS - 1)]
    expect(pruneStale(entries, now).map((e) => e.userId)).toEqual(['a', 'b'])
  })
})

describe('upsertBeat', () => {
  it('replaces the same user\'s heartbeat and preserves others', () => {
    const entries = [beat('a', 1, 'analysis'), beat('b', 1, 'design')]
    const next = upsertBeat(entries, beat('a', 5, 'requirements'))
    expect(next.filter((e) => e.userId === 'a')).toHaveLength(1)
    expect(next.find((e) => e.userId === 'a')?.surface).toBe('requirements')
    expect(next.find((e) => e.userId === 'b')?.surface).toBe('design')
  })
  it('adds a new user without touching existing entries', () => {
    const next = upsertBeat([beat('a', 1)], beat('b', 2))
    expect(next.map((e) => e.userId).sort()).toEqual(['a', 'b'])
  })
})
