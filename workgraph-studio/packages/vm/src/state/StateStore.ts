// ─────────────────────────────────────────────────────────────────────────────
// StateStore — persistence seam for the VM. The VM never talks to a concrete
// store directly; this interface lets us run on embedded SQLite locally and swap
// backends later. Receipts + outbox live here so they survive process restarts
// and can be synced back to audit-gov on reconnect.
// ─────────────────────────────────────────────────────────────────────────────

import type { VmRunState, VmReceipt } from '../types.js'

export interface OutboxEntry {
  id: string
  runId: string
  kind: string
  payload: unknown
  createdAt: string
  syncedAt?: string
}

export interface StateStore {
  init(): void
  saveRun(state: VmRunState): void
  loadRun(runId: string): VmRunState | undefined
  listRuns(): Array<Pick<VmRunState, 'runId' | 'workflowId' | 'status' | 'updatedAt'>>

  appendReceipt(receipt: VmReceipt): void
  listReceipts(runId: string): VmReceipt[]
  /** Latest receipt hash for a run — used to chain the next receipt. */
  lastReceiptHash(runId: string): string | undefined

  enqueueOutbox(entry: OutboxEntry): void
  pendingOutbox(): OutboxEntry[]
  markOutboxSynced(id: string, syncedAt: string): void

  close(): void
}
