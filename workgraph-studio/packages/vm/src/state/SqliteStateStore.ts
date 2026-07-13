// ─────────────────────────────────────────────────────────────────────────────
// SqliteStateStore — embedded state via Node's built-in node:sqlite. No native
// build step, runs anywhere Node 22+ runs. Pass ":memory:" for ephemeral runs
// or a file path for durable, resumable runs.
// ─────────────────────────────────────────────────────────────────────────────

import { DatabaseSync } from 'node:sqlite'
import type { StateStore, OutboxEntry } from './StateStore.js'
import type { VmRunState, VmReceipt } from '../types.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status      TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  state_json  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_run ON receipts(run_id, seq);
CREATE TABLE IF NOT EXISTS outbox (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  synced_at  TEXT
);
`

export class SqliteStateStore implements StateStore {
  private db: DatabaseSync

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
  }

  init(): void {
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
  }

  saveRun(state: VmRunState): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, workflow_id, status, updated_at, state_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status,
           updated_at = excluded.updated_at,
           state_json = excluded.state_json`,
      )
      .run(state.runId, state.workflowId, state.status, state.updatedAt, JSON.stringify(state))
  }

  loadRun(runId: string): VmRunState | undefined {
    const row = this.db.prepare('SELECT state_json FROM runs WHERE run_id = ?').get(runId) as
      | { state_json: string }
      | undefined
    return row ? (JSON.parse(row.state_json) as VmRunState) : undefined
  }

  listRuns(): Array<Pick<VmRunState, 'runId' | 'workflowId' | 'status' | 'updatedAt'>> {
    const rows = this.db
      .prepare('SELECT run_id, workflow_id, status, updated_at FROM runs ORDER BY updated_at DESC')
      .all() as Array<{ run_id: string; workflow_id: string; status: string; updated_at: string }>
    return rows.map(r => ({
      runId: r.run_id,
      workflowId: r.workflow_id,
      status: r.status as VmRunState['status'],
      updatedAt: r.updated_at,
    }))
  }

  appendReceipt(receipt: VmReceipt): void {
    const seqRow = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM receipts WHERE run_id = ?')
      .get(receipt.runId) as { m: number }
    this.db
      .prepare('INSERT INTO receipts (receipt_id, run_id, seq, hash, json) VALUES (?, ?, ?, ?, ?)')
      .run(receipt.receiptId, receipt.runId, seqRow.m + 1, receipt.hash, JSON.stringify(receipt))
  }

  listReceipts(runId: string): VmReceipt[] {
    const rows = this.db
      .prepare('SELECT json FROM receipts WHERE run_id = ? ORDER BY seq ASC')
      .all(runId) as Array<{ json: string }>
    return rows.map(r => JSON.parse(r.json) as VmReceipt)
  }

  lastReceiptHash(runId: string): string | undefined {
    const row = this.db
      .prepare('SELECT hash FROM receipts WHERE run_id = ? ORDER BY seq DESC LIMIT 1')
      .get(runId) as { hash: string } | undefined
    return row?.hash
  }

  enqueueOutbox(entry: OutboxEntry): void {
    this.db
      .prepare('INSERT INTO outbox (id, run_id, kind, payload, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.id, entry.runId, entry.kind, JSON.stringify(entry.payload), entry.createdAt, entry.syncedAt ?? null)
  }

  pendingOutbox(): OutboxEntry[] {
    const rows = this.db
      .prepare('SELECT id, run_id, kind, payload, created_at, synced_at FROM outbox WHERE synced_at IS NULL ORDER BY created_at ASC')
      .all() as Array<{ id: string; run_id: string; kind: string; payload: string; created_at: string; synced_at: string | null }>
    return rows.map(r => ({
      id: r.id,
      runId: r.run_id,
      kind: r.kind,
      payload: JSON.parse(r.payload),
      createdAt: r.created_at,
      syncedAt: r.synced_at ?? undefined,
    }))
  }

  markOutboxSynced(id: string, syncedAt: string): void {
    this.db.prepare('UPDATE outbox SET synced_at = ? WHERE id = ?').run(syncedAt, id)
  }

  close(): void {
    this.db.close()
  }
}
