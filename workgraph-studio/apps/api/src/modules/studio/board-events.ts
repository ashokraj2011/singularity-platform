/**
 * Studio Board — the pure event-sourcing core (PR-1 of the Studio Board spec).
 *
 * DB-free by design so it unit-tests without the stack (same discipline as
 * modules/rooms/belief.ts and the reconciliation engine): a deterministic
 * reducer that materializes board state from an append-only event log, plus the
 * coalescing and snapshot-policy decisions.
 *
 * Invariants: one event per semantic action; state is a pure fold over events;
 * unknown event types are no-ops so the log stays forward-compatible as new
 * event types (moments, ingestion, verdicts) land in later PRs. Nothing here
 * touches the DB, the clock, or randomness — time is always passed in.
 */
import { createHash } from 'crypto'

// A materialized board object: an id, an optional type, a soft-delete tombstone,
// and a free-form bag of properties (position, body, style, claim refs…). The
// reducer never invents semantics beyond what events assert.
export interface BoardObject {
  id: string
  // Everything else — type, body, position, the `deleted` tombstone, claim refs —
  // is opaque to the reducer: board objects are data, not a typed contract here.
  [k: string]: unknown
}
export type ObjectMap = Record<string, BoardObject>

// The shape the reducer needs from a BoardEvent (a subset of the Prisma row, so
// both persisted rows and in-flight inputs satisfy it).
export interface BoardEventLike {
  eventType: string
  objectIds?: unknown // Json — expected to be a string[]
  payload?: Record<string, unknown>
  actorType?: string
  actorId?: string | null
  coalesceKey?: string | null
  createdAt?: Date | string
}

export function asIds(objectIds: unknown): string[] {
  return Array.isArray(objectIds) ? objectIds.filter((x): x is string => typeof x === 'string') : []
}
export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * Apply one event to the object map, returning a NEW map (pure — never mutates
 * its input). One case per structural event type; semantic-only events (votes,
 * rituals, clusters, moments, verdicts…) don't change the object map in PR-1 and
 * pass through untouched.
 */
export function applyEvent(state: ObjectMap, ev: BoardEventLike): ObjectMap {
  const ids = asIds(ev.objectIds)
  const p = asRecord(ev.payload)
  switch (ev.eventType) {
    case 'OBJECT_CREATED': {
      const obj = asRecord(p.object)
      const id = String(obj.id ?? ids[0] ?? '')
      if (!id) return state
      return { ...state, [id]: { ...obj, id, deleted: false } }
    }
    case 'OBJECT_EDITED': {
      const id = ids[0]
      if (!id) return state
      const obj = state[id]
      if (!obj) return state
      return { ...state, [id]: { ...obj, ...asRecord(p.patch), id } }
    }
    case 'OBJECT_MOVED': {
      const id = ids[0]
      if (!id) return state
      const obj = state[id]
      if (!obj) return state
      return { ...state, [id]: { ...obj, position: asRecord(p.to) } }
    }
    case 'OBJECT_DELETED': {
      const id = ids[0]
      if (!id) return state
      const obj = state[id]
      if (!obj) return state
      return { ...state, [id]: { ...obj, deleted: true } }
    }
    case 'OBJECT_RESTORED': {
      const id = ids[0]
      if (!id) return state
      const obj = state[id]
      if (!obj) return state
      return { ...state, [id]: { ...obj, deleted: false } }
    }
    default:
      // LINK_*/CLUSTER_*/VOTE_*/FRAME_*/RITUAL_*/INGESTION_*/MOMENT_*/VERDICT_*:
      // no effect on the object map in PR-1 — forward-compatible no-op.
      return state
  }
}

/** Fold a run of events onto a base state. */
export function materialize(base: ObjectMap, events: BoardEventLike[]): ObjectMap {
  return events.reduce(applyEvent, base)
}

/**
 * Deterministic hash of state with stable key order, so the same logical state
 * always hashes identically — the integrity check (snapshot vs replay) and the
 * branch-diff short-circuit (identical hash ⇒ nothing to merge).
 */
export function hashState(state: ObjectMap): string {
  return createHash('sha256').update(stableStringify(state)).digest('hex')
}
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

// ── Coalescing ──────────────────────────────────────────────────────────────
// One semantic event per action: a drag is ONE OBJECT_MOVED (coalesced on 2s of
// pointer quiet), a text edit ONE OBJECT_EDITED per 5s. If an incoming event
// shares a coalesceKey + actor with the branch's most recent event, and lands
// within the window, we merge into that event instead of appending a new row —
// keeping replay legible and storage boring.
export const COALESCE_WINDOW_MS: Record<string, number> = {
  OBJECT_MOVED: 2000,
  OBJECT_EDITED: 5000,
}

export function shouldCoalesce(prev: BoardEventLike | null, next: BoardEventLike, nowMs: number): boolean {
  if (!prev) return false
  const window = COALESCE_WINDOW_MS[next.eventType]
  if (!window) return false
  if (prev.eventType !== next.eventType) return false
  if (!next.coalesceKey || prev.coalesceKey !== next.coalesceKey) return false
  if ((prev.actorType ?? '') !== (next.actorType ?? '')) return false
  if ((prev.actorId ?? null) !== (next.actorId ?? null)) return false
  const prevMs = prev.createdAt ? new Date(prev.createdAt).getTime() : 0
  return nowMs - prevMs <= window
}

export function coalescePayload(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  eventType: string,
): Record<string, unknown> {
  if (eventType === 'OBJECT_MOVED') {
    // Keep the drag's original origin, take the latest destination.
    return { from: prev.from ?? next.from, to: next.to ?? prev.to }
  }
  if (eventType === 'OBJECT_EDITED') {
    return { ...prev, ...next, patch: { ...asRecord(prev.patch), ...asRecord(next.patch) } }
  }
  return { ...prev, ...next }
}

// ── Snapshot policy ─────────────────────────────────────────────────────────
// Every 200 events or 15 min of activity, whichever first; plus forced snapshots
// at boundaries (fork / ritual / freeze). Replay cost is then bounded at
// nearest-snapshot + ≤200 applies → always interactive-speed.
export const SNAPSHOT_EVERY_EVENTS = 200
export const SNAPSHOT_EVERY_MS = 15 * 60 * 1000

export function isSnapshotDue(args: {
  seq: number
  lastSnapshotSeq: number
  sinceMs: number // timestamp of the last snapshot, or branch start if none
  nowMs: number
  boundary?: boolean
}): boolean {
  if (args.boundary) return true
  if (args.seq - args.lastSnapshotSeq >= SNAPSHOT_EVERY_EVENTS) return true
  return args.nowMs - args.sinceMs >= SNAPSHOT_EVERY_MS
}
