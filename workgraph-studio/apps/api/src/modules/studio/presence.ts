/**
 * Presence — the pure logic for "who's live in a project, on what". A heartbeat per user; entries
 * older than the TTL are considered gone. No I/O, no clock — `now` is passed in so it's unit-testable.
 * The service wraps these over an in-memory per-project store.
 */

export interface PresenceBeat {
  userId: string
  displayName?: string
  surface?: string
  cursor?: { x: number; y: number }
  viewport?: { x: number; y: number; zoom: number }
  at: number
}

export const PRESENCE_TTL_MS = 30_000

/** Drop heartbeats older than the TTL. */
export function pruneStale(entries: PresenceBeat[], now: number, ttlMs: number = PRESENCE_TTL_MS): PresenceBeat[] {
  return entries.filter((e) => now - e.at <= ttlMs)
}

/** Replace this user's heartbeat (one live entry per user), keeping everyone else. */
export function upsertBeat(entries: PresenceBeat[], beat: PresenceBeat): PresenceBeat[] {
  return [...entries.filter((e) => e.userId !== beat.userId), beat]
}
