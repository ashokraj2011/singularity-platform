/**
 * Live co-edit relay — the pure log logic. The server is a DUMB relay: it stores opaque Yjs update
 * blobs (base64) in an append-only, per-document log and hands each client the updates it hasn't seen
 * yet. All CRDT merging happens on the clients (Yjs updates are commutative + idempotent, so applying
 * them in any order converges). No `yjs` dependency here — the server never decodes an update.
 */

export interface CoeditEntry {
  seq: number
  update: string
}

/** Append opaque updates, assigning each the next monotonic seq. Returns a new array. */
export function appendUpdates(log: CoeditEntry[], updates: string[]): CoeditEntry[] {
  let seq = log.length ? log[log.length - 1].seq : 0
  return [...log, ...updates.map((update) => ({ seq: ++seq, update }))]
}

/** The updates a client with the given high-water seq still needs. */
export function updatesSince(log: CoeditEntry[], sinceSeq: number): CoeditEntry[] {
  return log.filter((e) => e.seq > sinceSeq)
}

/** The latest seq in the log (0 when empty). */
export function headSeq(log: CoeditEntry[]): number {
  return log.length ? log[log.length - 1].seq : 0
}
