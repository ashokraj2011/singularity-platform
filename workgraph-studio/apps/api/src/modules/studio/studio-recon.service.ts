/**
 * Project-level reconciliation roll-up — the walkthrough's Reconcile screen, aggregated across a
 * project's work items. Read-only: for each work item in the project it takes the LATEST
 * reconciliation run (status + pass/partial/fail summary) and folds them into a project total.
 * Reuses the per-Work-Item ReconciliationRun data; nothing new is computed here.
 */
import { prisma } from '../../lib/prisma'
import { getProject } from './studio-projects.service'

/** Pull the pass/partial/fail counts out of a run's summary JSON, defensively. */
export function summaryCounts(summary: unknown): { pass: number; partial: number; fail: number } {
  const s = (summary ?? {}) as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return { pass: n(s.pass), partial: n(s.partial), fail: n(s.fail) }
}

export interface ProjectReconciliationRollup {
  itemsTotal: number
  itemsReconciled: number
  pass: number
  partial: number
  fail: number
}

export async function getProjectReconciliation(projectId: string) {
  await getProject(projectId) // 404s if the project isn't visible to the tenant

  const workItems = await prisma.workItem.findMany({
    where: { projectId },
    select: { id: true, workCode: true, title: true, status: true },
    orderBy: { createdAt: 'desc' },
  })

  const items = await Promise.all(
    workItems.map(async (wi) => {
      const latestRun = await prisma.reconciliationRun.findFirst({
        where: { workItemId: wi.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, mode: true, summary: true, startedAt: true, completedAt: true },
      })
      return {
        workItem: wi,
        latestRun: latestRun
          ? { ...latestRun, counts: summaryCounts(latestRun.summary) }
          : null,
      }
    }),
  )

  const rollup: ProjectReconciliationRollup = { itemsTotal: workItems.length, itemsReconciled: 0, pass: 0, partial: 0, fail: 0 }
  for (const it of items) {
    if (!it.latestRun) continue
    rollup.itemsReconciled += 1
    rollup.pass += it.latestRun.counts.pass
    rollup.partial += it.latestRun.counts.partial
    rollup.fail += it.latestRun.counts.fail
  }

  return { items, rollup }
}
