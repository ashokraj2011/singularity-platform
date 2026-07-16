/**
 * Studio Board — semantic merge pure core (PR-6). Never CRDT-merge: a CRDT resolves
 * textual conflict but can't resolve MEANING conflict (branch A killed a region branch
 * B built on). So merge is a three-way SEMANTIC diff → a reviewable proposal batch.
 *
 * A change is MATERIAL if it alters meaning (add / remove / body-or-claims changed) —
 * those need review. It's SPATIAL if it's only position / style / cluster membership —
 * position noise auto-merges. A CONFLICT is an object materially changed on BOTH sides
 * since the fork; those are never auto-resolved. Pure so it unit-tests without the DB.
 */
import type { ObjectMap, BoardObject } from './board-events'

export type DiffChange = 'ADDED' | 'REMOVED' | 'CONTENT_CHANGED' | 'MOVED' | 'RESTYLED'
export type DiffClass = 'MATERIAL' | 'SPATIAL'
export interface DiffItem {
  objectId: string
  change: DiffChange
  klass: DiffClass
  conflict: boolean // materially changed on both branch and main since the fork
}

const MATERIAL_CHANGES: readonly DiffChange[] = ['ADDED', 'REMOVED', 'CONTENT_CHANGED']
const SPATIAL_KEYS = new Set(['position', 'x', 'y', 'z', 'style', 'cluster', 'clusterId'])

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}
function present(o: BoardObject | undefined): boolean { return !!o && !o.deleted }
function get(o: BoardObject, k: string): unknown { return (o as Record<string, unknown>)[k] }

function contentSig(o: BoardObject): string {
  const rest: Record<string, unknown> = {}
  for (const k of Object.keys(o)) if (!SPATIAL_KEYS.has(k) && k !== 'deleted') rest[k] = get(o, k)
  return stableStringify(rest)
}
function positionSig(o: BoardObject): string {
  return stableStringify({ position: get(o, 'position') ?? null, x: get(o, 'x') ?? null, y: get(o, 'y') ?? null, z: get(o, 'z') ?? null })
}
function styleSig(o: BoardObject): string {
  return stableStringify({ style: get(o, 'style') ?? null, cluster: get(o, 'cluster') ?? get(o, 'clusterId') ?? null })
}

/** How `side` changed the object relative to `base`, or null if unchanged. */
export function classifyChange(base: BoardObject | undefined, side: BoardObject | undefined): DiffChange | null {
  const b = present(base)
  const s = present(side)
  if (!b && s) return 'ADDED'
  if (b && !s) return 'REMOVED'
  if (!b && !s) return null
  if (contentSig(base!) !== contentSig(side!)) return 'CONTENT_CHANGED'
  if (positionSig(base!) !== positionSig(side!)) return 'MOVED'
  if (styleSig(base!) !== styleSig(side!)) return 'RESTYLED'
  return null
}

export function isMaterial(change: DiffChange): boolean {
  return MATERIAL_CHANGES.includes(change)
}

/**
 * Three-way diff: `base` = state at the fork point, `branch` = the branch head to merge,
 * `main` = the target head. Reports only objects the branch changed; flags conflicts
 * where main also materially changed the same object since the fork.
 */
export function diffStates(base: ObjectMap, branch: ObjectMap, main: ObjectMap): { items: DiffItem[] } {
  const ids = new Set<string>([...Object.keys(base), ...Object.keys(branch), ...Object.keys(main)])
  const items: DiffItem[] = []
  for (const id of ids) {
    const branchChange = classifyChange(base[id], branch[id])
    if (!branchChange) continue // branch didn't touch it → nothing to merge
    const klass: DiffClass = isMaterial(branchChange) ? 'MATERIAL' : 'SPATIAL'
    const mainChange = classifyChange(base[id], main[id])
    const conflict = klass === 'MATERIAL' && !!mainChange && isMaterial(mainChange)
    items.push({ objectId: id, change: branchChange, klass, conflict })
  }
  return { items: items.sort((x, y) => x.objectId.localeCompare(y.objectId)) }
}

export interface DiffSummary { total: number; spatial: number; material: number; conflicts: number }
export function summarizeDiff(items: DiffItem[]): DiffSummary {
  return {
    total: items.length,
    spatial: items.filter((i) => i.klass === 'SPATIAL').length,
    material: items.filter((i) => i.klass === 'MATERIAL').length,
    conflicts: items.filter((i) => i.conflict).length,
  }
}
