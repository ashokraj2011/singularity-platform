/**
 * Studio live co-edit relay — in-memory, per-(project, document) append-only log of opaque Yjs
 * updates. A sync call appends the caller's new updates and returns everything past the caller's
 * high-water seq, so all clients converge. Ephemeral by design (no DB, no history beyond the session);
 * a multi-instance deploy would need a shared store (Redis/stream) — fine for the single-instance
 * stack. Transport is HTTP (this + the router), so the WebSocket-less relay rides the existing proxy.
 */
import { getProject } from './studio-projects.service'
import { appendUpdates, updatesSince, headSeq, type CoeditEntry } from './coedit'

const store = new Map<string, CoeditEntry[]>()
// Soft cap so a long session can't grow unbounded. Dropping the oldest updates would strand a brand-new
// joiner (they replay from seq 0), so the cap is set well above any realistic single-session edit count.
const MAX_LOG = 20_000

const keyOf = (projectId: string, docKey: string) => `${projectId}::${docKey}`

export interface CoeditSyncInput {
  docKey: string
  updates: string[]
  sinceSeq: number
}

export async function syncCoedit(projectId: string, input: CoeditSyncInput): Promise<{ updates: CoeditEntry[]; head: number }> {
  await getProject(projectId) // tenant-scoped 404 — don't relay edits across projects the caller can't see
  const key = keyOf(projectId, input.docKey)

  let log = store.get(key) ?? []
  if (input.updates.length) {
    log = appendUpdates(log, input.updates)
    if (log.length > MAX_LOG) log = log.slice(-MAX_LOG)
    store.set(key, log)
  }

  return { updates: updatesSince(log, input.sinceSeq), head: headSeq(log) }
}
