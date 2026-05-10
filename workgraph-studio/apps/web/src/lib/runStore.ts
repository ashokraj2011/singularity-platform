/**
 * Browser-runtime persistence — IndexedDB-backed store for RunState plus a
 * thin client for the server snapshot endpoint.
 *
 * The IndexedDB row is the source of truth while the page is open; the server
 * blob is the durability backstop for cross-device / cache-clear scenarios.
 */

import { openDB, type IDBPDatabase } from 'idb'
import type { RunState } from '@workgraph/engine'
import { api } from './api'

const DB_NAME    = 'workgraph-runs'
const DB_VERSION = 1
const STORE      = 'runs'

let dbPromise: Promise<IDBPDatabase> | null = null

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'runId' })
          store.createIndex('workflowId', 'workflowId', { unique: false })
          store.createIndex('status',     'status',     { unique: false })
          store.createIndex('updatedAt',  'updatedAt',  { unique: false })
        }
      },
    })
  }
  return dbPromise
}

export async function saveRun(state: RunState): Promise<void> {
  const db = await getDb()
  await db.put(STORE, state)
}

export async function getRun(runId: string): Promise<RunState | null> {
  const db = await getDb()
  const row = await db.get(STORE, runId)
  return (row as RunState | undefined) ?? null
}

export async function listRuns(opts?: { workflowId?: string }): Promise<RunState[]> {
  const db = await getDb()
  if (opts?.workflowId) {
    return db.getAllFromIndex(STORE, 'workflowId', opts.workflowId)
  }
  return db.getAll(STORE)
}

export async function deleteRun(runId: string): Promise<void> {
  const db = await getDb()
  await db.delete(STORE, runId)
}

// ─── Server snapshot client ─────────────────────────────────────────────────

export async function pushSnapshot(state: RunState): Promise<{ ok: boolean; conflict?: boolean }> {
  try {
    await api.post(`/runs/${state.runId}/snapshot`, {
      workflowId: state.workflowId,
      name:       state.name,
      status:     state.status,
      version:    state.version,
      payload:    state,
    })
    return { ok: true }
  } catch (err: any) {
    const status = err?.response?.status
    if (status === 409) return { ok: false, conflict: true }
    // Network errors are non-fatal — IndexedDB still has the truth
    return { ok: false }
  }
}

export async function fetchSnapshot(runId: string): Promise<RunState | null> {
  try {
    const { data } = await api.get(`/runs/${runId}/snapshot`)
    return (data?.payload ?? null) as RunState | null
  } catch (err: any) {
    if (err?.response?.status === 404) return null
    throw err
  }
}

export async function listMyRunSnapshots(): Promise<Array<{
  runId: string
  workflowId: string
  workflow?: { id: string; name: string }
  name: string
  status: string
  version: number
  updatedAt: string
}>> {
  const { data } = await api.get('/runs', { params: { mine: 'true' } })
  return data
}

export async function abandonRun(runId: string): Promise<void> {
  await deleteRun(runId)
  try { await api.delete(`/runs/${runId}`) } catch { /* best effort */ }
}
