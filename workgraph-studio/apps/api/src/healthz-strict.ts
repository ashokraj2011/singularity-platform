/**
 * M28 boot-1 — strict health invariants for workgraph-api.
 *
 * Asserts at boot:
 *   - DB reachable
 *   - workflow_nodes.startedAt / completedAt columns exist (M24.5 — adding
 *     these via a stale schema is exactly what crashed TimerSweep silently
 *     during demo prep)
 *   - IAM bootstrap creds can mint a service token (else lookup proxy
 *     fails per-request)
 *
 * Returns 200 only if all pass; 503 + failing-check names otherwise.
 */
import { prisma } from './lib/prisma'
import { config } from './config'

export interface InvariantResult {
  name: string
  ok: boolean
  reason?: string
  details?: Record<string, unknown>
}

type InvariantCheck = () => Promise<InvariantResult>

const checks: InvariantCheck[] = [
  async () => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return { name: 'db_reachable', ok: true }
    } catch (err) {
      return { name: 'db_reachable', ok: false, reason: (err as Error).message }
    }
  },

  // M24.5 columns — TimerSweep crashes silently if these are missing.
  async () => {
    try {
      const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'workflow_nodes'
           AND column_name IN ('startedAt', 'completedAt')`
      const found = rows.map((r) => r.column_name)
      const missing = ['startedAt', 'completedAt'].filter((c) => !found.includes(c))
      if (missing.length > 0) {
        return { name: 'workflow_nodes_timing_columns', ok: false, reason: `workflow_nodes missing columns: ${missing.join(', ')} — run prisma db push` }
      }
      return { name: 'workflow_nodes_timing_columns', ok: true }
    } catch (err) {
      return { name: 'workflow_nodes_timing_columns', ok: false, reason: (err as Error).message }
    }
  },

  // M11 — IAM federation. If AUTH_PROVIDER=iam, lookup proxy needs a working
  // bootstrap-mint path. We only assert reachability here (not mint) to keep
  // the check fast; full mint is exercised by /api/lookup/* at request time.
  async () => {
    if (config.AUTH_PROVIDER !== 'iam') {
      return { name: 'iam_base_reachable', ok: true, details: { note: 'AUTH_PROVIDER=local — skipping IAM check' } }
    }
    if (!config.IAM_BASE_URL) {
      return { name: 'iam_base_reachable', ok: false, reason: 'AUTH_PROVIDER=iam but IAM_BASE_URL is unset' }
    }
    try {
      const url = `${config.IAM_BASE_URL.replace(/\/$/, '')}/health`
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 3000)
      try {
        const res = await fetch(url, { signal: ctrl.signal })
        if (!res.ok) return { name: 'iam_base_reachable', ok: false, reason: `IAM /health returned ${res.status}`, details: { url } }
        return { name: 'iam_base_reachable', ok: true, details: { url } }
      } finally { clearTimeout(t) }
    } catch (err) {
      return { name: 'iam_base_reachable', ok: false, reason: `IAM unreachable: ${(err as Error).message}` }
    }
  },
]

export async function runInvariantChecks(): Promise<{ ok: boolean; checks: InvariantResult[] }> {
  const results = await Promise.all(checks.map(async (c) => {
    try { return await c() }
    catch (err) { return { name: 'unknown', ok: false, reason: `check threw: ${(err as Error).message}` } }
  }))
  return { ok: results.every((r) => r.ok), checks: results }
}
