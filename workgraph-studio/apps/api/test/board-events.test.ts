/**
 * Unit tests for the Studio Board pure event-sourcing core (PR-1). DB-free —
 * exercises the reducer, replay fold, state hashing, coalescing windows, and the
 * snapshot policy, which are the load-bearing logic behind time travel.
 */
import { describe, it, expect } from 'vitest'
import {
  applyEvent, materialize, hashState, shouldCoalesce, coalescePayload, isSnapshotDue,
  type ObjectMap, type BoardEventLike,
} from '../src/modules/studio/board-events'

const created = (id: string, props: Record<string, unknown> = {}): BoardEventLike => ({
  eventType: 'OBJECT_CREATED', objectIds: [id], payload: { object: { id, ...props } },
})

describe('applyEvent', () => {
  it('OBJECT_CREATED adds an object', () => {
    const s = applyEvent({}, created('o1', { type: 'sticky', body: 'hi' }))
    expect(s.o1).toMatchObject({ id: 'o1', type: 'sticky', body: 'hi', deleted: false })
  })

  it('OBJECT_EDITED merges the patch', () => {
    const s0 = applyEvent({}, created('o1', { body: 'hi' }))
    const s1 = applyEvent(s0, { eventType: 'OBJECT_EDITED', objectIds: ['o1'], payload: { patch: { body: 'bye', color: 'red' } } })
    expect(s1.o1).toMatchObject({ id: 'o1', body: 'bye', color: 'red' })
  })

  it('OBJECT_MOVED sets position', () => {
    const s0 = applyEvent({}, created('o1'))
    const s1 = applyEvent(s0, { eventType: 'OBJECT_MOVED', objectIds: ['o1'], payload: { from: { x: 0, y: 0 }, to: { x: 5, y: 9 } } })
    expect(s1.o1.position).toEqual({ x: 5, y: 9 })
    expect(s1.o1).toMatchObject({ x: 5, y: 9 })
  })

  it('OBJECT_DELETED tombstones, OBJECT_RESTORED revives', () => {
    const s0 = applyEvent({}, created('o1'))
    const del = applyEvent(s0, { eventType: 'OBJECT_DELETED', objectIds: ['o1'] })
    expect(del.o1.deleted).toBe(true)
    const res = applyEvent(del, { eventType: 'OBJECT_RESTORED', objectIds: ['o1'] })
    expect(res.o1.deleted).toBe(false)
  })

  it('edit/move/delete on a missing object is a no-op', () => {
    const s = applyEvent({}, { eventType: 'OBJECT_EDITED', objectIds: ['ghost'], payload: { patch: { body: 'x' } } })
    expect(s).toEqual({})
  })

  it('unknown / semantic-only event types are forward-compatible no-ops', () => {
    const s0 = applyEvent({}, created('o1'))
    const s1 = applyEvent(s0, { eventType: 'VOTE_CAST', objectIds: ['o1'], payload: { target: 'o1' } })
    const s2 = applyEvent(s1, { eventType: 'MOMENT_MARKED' })
    expect(s2).toEqual(s0)
  })

  it('is pure — never mutates its input', () => {
    const base: ObjectMap = { o1: { id: 'o1', body: 'hi', deleted: false } }
    const snapshot = JSON.parse(JSON.stringify(base))
    applyEvent(base, { eventType: 'OBJECT_EDITED', objectIds: ['o1'], payload: { patch: { body: 'changed' } } })
    expect(base).toEqual(snapshot)
  })
})

describe('materialize', () => {
  it('folds a run of events into final state', () => {
    const events: BoardEventLike[] = [
      created('a', { body: 'A' }),
      created('b', { body: 'B' }),
      { eventType: 'OBJECT_EDITED', objectIds: ['a'], payload: { patch: { body: 'A2' } } },
      { eventType: 'OBJECT_DELETED', objectIds: ['b'] },
    ]
    const state = materialize({}, events)
    expect(state.a.body).toBe('A2')
    expect(state.b.deleted).toBe(true)
  })

  it('replaying from a snapshot base equals replaying from scratch', () => {
    const all: BoardEventLike[] = [created('a'), created('b'), { eventType: 'OBJECT_MOVED', objectIds: ['a'], payload: { to: { x: 3 } } }]
    const full = materialize({}, all)
    const snapAt1 = materialize({}, all.slice(0, 1)) // "snapshot" after event 1
    const resumed = materialize(snapAt1, all.slice(1))
    expect(resumed).toEqual(full)
  })
})

describe('hashState', () => {
  it('is stable across key order', () => {
    const a: ObjectMap = { o1: { id: 'o1', a: 1, b: 2, deleted: false } }
    const b: ObjectMap = { o1: { deleted: false, b: 2, a: 1, id: 'o1' } }
    expect(hashState(a)).toBe(hashState(b))
  })
  it('changes when state changes', () => {
    const a: ObjectMap = { o1: { id: 'o1', body: 'x', deleted: false } }
    const b: ObjectMap = { o1: { id: 'o1', body: 'y', deleted: false } }
    expect(hashState(a)).not.toBe(hashState(b))
  })
})

describe('shouldCoalesce', () => {
  const prev = (type: string, ms: number, key = 'o1', actorId = 'u1'): BoardEventLike =>
    ({ eventType: type, coalesceKey: key, actorType: 'HUMAN', actorId, createdAt: new Date(ms) })
  const next = (type: string, key = 'o1', actorId = 'u1'): BoardEventLike =>
    ({ eventType: type, coalesceKey: key, actorType: 'HUMAN', actorId })

  it('coalesces a MOVED within the 2s window', () => {
    expect(shouldCoalesce(prev('OBJECT_MOVED', 1000), next('OBJECT_MOVED'), 2500)).toBe(true)
  })
  it('does NOT coalesce a MOVED past 2s', () => {
    expect(shouldCoalesce(prev('OBJECT_MOVED', 1000), next('OBJECT_MOVED'), 4000)).toBe(false)
  })
  it('coalesces an EDITED within the 5s window', () => {
    expect(shouldCoalesce(prev('OBJECT_EDITED', 1000), next('OBJECT_EDITED'), 5500)).toBe(true)
  })
  it('never coalesces across different actors, keys, or types', () => {
    expect(shouldCoalesce(prev('OBJECT_MOVED', 1000, 'o1', 'u1'), next('OBJECT_MOVED', 'o1', 'u2'), 1500)).toBe(false)
    expect(shouldCoalesce(prev('OBJECT_MOVED', 1000, 'o1'), next('OBJECT_MOVED', 'o2'), 1500)).toBe(false)
    expect(shouldCoalesce(prev('OBJECT_MOVED', 1000), next('OBJECT_EDITED'), 1500)).toBe(false)
  })
  it('never coalesces types with no window (e.g. OBJECT_CREATED) or a null prev', () => {
    expect(shouldCoalesce(prev('OBJECT_CREATED', 1000), next('OBJECT_CREATED'), 1100)).toBe(false)
    expect(shouldCoalesce(null, next('OBJECT_MOVED'), 1100)).toBe(false)
  })
})

describe('coalescePayload', () => {
  it('MOVED keeps origin, takes latest destination', () => {
    expect(coalescePayload({ from: { x: 0 }, to: { x: 3 } }, { from: { x: 3 }, to: { x: 9 } }, 'OBJECT_MOVED'))
      .toEqual({ from: { x: 0 }, to: { x: 9 } })
  })
  it('EDITED merges patches', () => {
    expect(coalescePayload({ patch: { a: 1, b: 1 } }, { patch: { b: 2, c: 3 } }, 'OBJECT_EDITED'))
      .toMatchObject({ patch: { a: 1, b: 2, c: 3 } })
  })
})

describe('isSnapshotDue', () => {
  it('fires at the 200-event threshold', () => {
    expect(isSnapshotDue({ seq: 200, lastSnapshotSeq: 0, sinceMs: 0, nowMs: 1000 })).toBe(true)
    expect(isSnapshotDue({ seq: 199, lastSnapshotSeq: 0, sinceMs: 0, nowMs: 1000 })).toBe(false)
  })
  it('fires after 15 minutes of activity', () => {
    const fifteenMin = 15 * 60 * 1000
    expect(isSnapshotDue({ seq: 10, lastSnapshotSeq: 0, sinceMs: 0, nowMs: fifteenMin })).toBe(true)
    expect(isSnapshotDue({ seq: 10, lastSnapshotSeq: 0, sinceMs: 0, nowMs: fifteenMin - 1 })).toBe(false)
  })
  it('a forced boundary always snapshots', () => {
    expect(isSnapshotDue({ seq: 3, lastSnapshotSeq: 0, sinceMs: 0, nowMs: 1, boundary: true })).toBe(true)
  })
})
