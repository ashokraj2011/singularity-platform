import { reapExpiredReconciliationJobs } from './reconciliations.service'

export function startReconciliationLeaseReaper(): void {
  if ((process.env.RECONCILIATION_LEASE_REAPER_ENABLED ?? 'true').toLowerCase() !== 'true') {
    console.log('Reconciliation lease reaper disabled (RECONCILIATION_LEASE_REAPER_ENABLED=false)')
    return
  }
  const configured = Number(process.env.RECONCILIATION_LEASE_REAPER_INTERVAL_MS ?? 30_000)
  const intervalMs = Number.isFinite(configured) ? Math.max(configured, 5_000) : 30_000
  const sweep = () => {
    void reapExpiredReconciliationJobs().catch((err) => {
      console.warn('[reconciliation-lease-reaper] sweep failed:', (err as Error).message)
    })
  }
  sweep()
  const timer = setInterval(sweep, intervalMs)
  timer.unref()
}
