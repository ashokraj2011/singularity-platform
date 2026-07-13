// ─────────────────────────────────────────────────────────────────────────────
// Receipt sync — on reconnect, replay the offline outbox (queued audit events +
// receipts) to the central audit-governance service. Idempotent: each entry is
// marked synced only after a successful POST, so a crash mid-sync re-sends only
// the un-acked entries. Never drops an event.
// ─────────────────────────────────────────────────────────────────────────────

import type { StateStore } from '../state/StateStore.js'
import type { Clock } from '../types.js'
import { systemClock } from '../adapters/offline.js'

export interface SyncTarget {
  baseUrl: string
  token?: string
  path?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface SyncResult {
  attempted: number
  synced: number
  failed: number
  errors: string[]
}

export async function syncOutbox(
  store: StateStore,
  target: SyncTarget,
  clock: Clock = systemClock,
): Promise<SyncResult> {
  const pending = store.pendingOutbox()
  const path = target.path ?? '/api/v1/events'
  const timeoutMs = target.timeoutMs ?? 10_000
  const fetchImpl = target.fetchImpl ?? fetch
  const result: SyncResult = { attempted: pending.length, synced: 0, failed: 0, errors: [] }

  for (const entry of pending) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        // Idempotency key lets audit-gov dedupe re-sent entries.
        'idempotency-key': entry.id,
      }
      if (target.token) headers.authorization = `Bearer ${target.token}`
      const res = await fetchImpl(`${target.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(entry.payload),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      store.markOutboxSynced(entry.id, clock.now().toISOString())
      result.synced++
    } catch (err) {
      result.failed++
      result.errors.push(`${entry.id}: ${(err as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }
  return result
}
