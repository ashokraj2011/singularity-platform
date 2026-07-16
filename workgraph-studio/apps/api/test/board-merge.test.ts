/**
 * Unit tests for the Studio Board semantic-merge pure core (PR-6): the three-way
 * diff that classifies MATERIAL vs SPATIAL and flags conflicts. DB-free.
 */
import { describe, it, expect } from 'vitest'
import { classifyChange, diffStates, summarizeDiff, isMaterial, type DiffItem } from '../src/modules/studio/board-merge'
import type { ObjectMap, BoardObject } from '../src/modules/studio/board-events'

const obj = (id: string, over: Record<string, unknown> = {}): BoardObject => ({ id, deleted: false, ...over })

describe('classifyChange', () => {
  it('detects ADDED / REMOVED', () => {
    expect(classifyChange(undefined, obj('a'))).toBe('ADDED')
    expect(classifyChange(obj('a'), { id: 'a', deleted: true })).toBe('REMOVED')
  })
  it('detects CONTENT_CHANGED (body) as distinct from MOVED (position) and RESTYLED (style)', () => {
    expect(classifyChange(obj('a', { body: 'x' }), obj('a', { body: 'y' }))).toBe('CONTENT_CHANGED')
    expect(classifyChange(obj('a', { position: { x: 0 } }), obj('a', { position: { x: 9 } }))).toBe('MOVED')
    expect(classifyChange(obj('a', { style: 'blue' }), obj('a', { style: 'red' }))).toBe('RESTYLED')
  })
  it('returns null when nothing changed', () => {
    expect(classifyChange(obj('a', { body: 'x' }), obj('a', { body: 'x' }))).toBeNull()
  })
})

describe('isMaterial', () => {
  it('marks meaning-altering changes material, spatial ones not', () => {
    expect(isMaterial('CONTENT_CHANGED')).toBe(true)
    expect(isMaterial('ADDED')).toBe(true)
    expect(isMaterial('REMOVED')).toBe(true)
    expect(isMaterial('MOVED')).toBe(false)
    expect(isMaterial('RESTYLED')).toBe(false)
  })
})

describe('diffStates — three-way', () => {
  it('reports only what the branch changed, classified', () => {
    const base: ObjectMap = { a: obj('a', { body: 'A' }), b: obj('b', { body: 'B' }), c: obj('c', { position: { x: 0 } }) }
    const branch: ObjectMap = {
      a: obj('a', { body: 'A2' }), // CONTENT_CHANGED → MATERIAL
      b: obj('b', { body: 'B' }), // unchanged → omitted
      c: obj('c', { position: { x: 5 } }), // MOVED → SPATIAL
      d: obj('d', { body: 'D' }), // ADDED → MATERIAL
    }
    const main: ObjectMap = { ...base }
    const { items } = diffStates(base, branch, main)
    const byId = Object.fromEntries(items.map((i) => [i.objectId, i]))
    expect(byId.a).toMatchObject({ change: 'CONTENT_CHANGED', klass: 'MATERIAL', conflict: false })
    expect(byId.c).toMatchObject({ change: 'MOVED', klass: 'SPATIAL' })
    expect(byId.d).toMatchObject({ change: 'ADDED', klass: 'MATERIAL' })
    expect(byId.b).toBeUndefined()
  })

  it('flags a CONFLICT when both sides materially changed the same object since fork', () => {
    const base: ObjectMap = { a: obj('a', { body: 'A' }) }
    const branch: ObjectMap = { a: obj('a', { body: 'branch-edit' }) }
    const main: ObjectMap = { a: obj('a', { body: 'main-edit' }) }
    const item = diffStates(base, branch, main).items.find((i) => i.objectId === 'a') as DiffItem
    expect(item.conflict).toBe(true)
  })

  it('does NOT conflict when only the branch changed (main untouched since fork)', () => {
    const base: ObjectMap = { a: obj('a', { body: 'A' }) }
    const branch: ObjectMap = { a: obj('a', { body: 'branch-edit' }) }
    const main: ObjectMap = { a: obj('a', { body: 'A' }) }
    expect(diffStates(base, branch, main).items[0]!.conflict).toBe(false)
  })

  it('a spatial-only branch change is never a conflict even if main edited content', () => {
    const base: ObjectMap = { a: obj('a', { body: 'A', position: { x: 0 } }) }
    const branch: ObjectMap = { a: obj('a', { body: 'A', position: { x: 9 } }) } // moved only
    const main: ObjectMap = { a: obj('a', { body: 'main-edit', position: { x: 0 } }) }
    const item = diffStates(base, branch, main).items[0]!
    expect(item.klass).toBe('SPATIAL')
    expect(item.conflict).toBe(false)
  })
})

describe('summarizeDiff', () => {
  it('counts by class and conflicts', () => {
    const items: DiffItem[] = [
      { objectId: 'a', change: 'CONTENT_CHANGED', klass: 'MATERIAL', conflict: true },
      { objectId: 'b', change: 'MOVED', klass: 'SPATIAL', conflict: false },
      { objectId: 'c', change: 'ADDED', klass: 'MATERIAL', conflict: false },
    ]
    expect(summarizeDiff(items)).toEqual({ total: 3, spatial: 1, material: 2, conflicts: 1 })
  })
})
