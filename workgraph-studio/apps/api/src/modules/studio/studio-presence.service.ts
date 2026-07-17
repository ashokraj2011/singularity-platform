/**
 * Studio presence — the live "who's here" layer over a Specification Project. In-memory, per-process:
 * clients heartbeat every few seconds; a heartbeat both records the caller and returns the current
 * live set (stale entries pruned by TTL). Ephemeral by design — no DB, no history. NOTE: per-process,
 * so a multi-instance deployment would need a shared store (Redis); fine for the single-instance stack.
 */
import { getProject } from './studio-projects.service'
import { pruneStale, upsertBeat, type PresenceBeat } from './presence'

const store = new Map<string, PresenceBeat[]>()

function live(projectId: string, now: number): PresenceBeat[] {
  const next = pruneStale(store.get(projectId) ?? [], now)
  if (next.length) store.set(projectId, next)
  else store.delete(projectId)
  return next
}

export interface HeartbeatInput {
  userId: string
  displayName?: string
  surface?: string
  cursor?: { x: number; y: number }
  viewport?: { x: number; y: number; zoom: number }
}

export async function recordPresence(projectId: string, input: HeartbeatInput): Promise<{ present: PresenceBeat[] }> {
  await getProject(projectId) // tenant-scoped 404 — don't leak presence across projects the caller can't see
  const now = Date.now()
  const beat: PresenceBeat = { userId: input.userId, displayName: input.displayName, surface: input.surface, cursor: input.cursor, viewport: input.viewport, at: now }
  const next = upsertBeat(pruneStale(store.get(projectId) ?? [], now), beat)
  store.set(projectId, next)
  return { present: next }
}

export async function readPresence(projectId: string): Promise<{ present: PresenceBeat[] }> {
  await getProject(projectId)
  return { present: live(projectId, Date.now()) }
}
