import { prisma } from '../../lib/prisma'
import { canViewWorkItem } from '../work-items/work-items.service'

/**
 * Cross-Work-Item reconciliation overview (operator cockpit). Aggregates recent reconciliation runs
 * and implementation submissions across every Work Item the caller can see (tenant-scoped by the
 * prisma proxy), plus status tallies. Read-only; each row carries its Work Item context so the UI
 * can deep-link into the workspace.
 */

interface StatusGroup {
  status: string
  _count: number | { _all?: number }
}

/** Fold prisma groupBy rows into a { total, byStatus } tally. Pure — unit-testable. */
export function tallyByStatus(rows: StatusGroup[]): { total: number; byStatus: Record<string, number> } {
  const byStatus: Record<string, number> = {}
  let total = 0
  for (const r of rows) {
    const n = typeof r._count === 'number' ? r._count : r._count?._all ?? 0
    byStatus[r.status] = (byStatus[r.status] ?? 0) + n
    total += n
  }
  return { total, byStatus }
}

export async function getReconciliationOverview(userId: string, limit = 25) {
  const take = Math.min(Math.max(limit, 1), 100)
  const candidateTake = Math.min(take * 4, 400)
  const [runs, submissions] = await Promise.all([
    prisma.reconciliationRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: candidateTake,
      include: { workItem: { include: { targets: true } } },
    }),
    prisma.implementationSubmission.findMany({
      orderBy: { createdAt: 'desc' },
      take: candidateTake,
      include: { workItem: { include: { targets: true } } },
    }),
  ])
  const workItems = new Map([...runs, ...submissions].map(row => [row.workItem.id, row.workItem]))
  const access = await Promise.all([...workItems.values()].map(async workItem => [workItem.id, await canViewWorkItem(userId, workItem)] as const))
  const visibleWorkItemIds = new Set(access.filter(([, allowed]) => allowed).map(([workItemId]) => workItemId))
  const visibleRuns = runs.filter(row => visibleWorkItemIds.has(row.workItemId)).slice(0, take)
  const visibleSubmissions = submissions.filter(row => visibleWorkItemIds.has(row.workItemId)).slice(0, take)
  const grouped = (rows: Array<{ status: string }>) => {
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(String(row.status), (counts.get(String(row.status)) ?? 0) + 1)
    return [...counts.entries()].map(([status, count]) => ({ status, _count: count }))
  }
  const runGroups = grouped(visibleRuns)
  const submissionGroups = grouped(visibleSubmissions)

  return {
    summary: {
      reconciliations: tallyByStatus(runGroups as StatusGroup[]),
      submissions: tallyByStatus(submissionGroups as StatusGroup[]),
    },
    recentReconciliations: visibleRuns.map((r) => ({
      id: r.id,
      workItemId: r.workItemId,
      workCode: r.workItem?.workCode ?? null,
      title: r.workItem?.title ?? null,
      submissionId: r.submissionId,
      status: r.status,
      mode: r.mode,
      summary: r.summary,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    })),
    recentSubmissions: visibleSubmissions.map((s) => ({
      id: s.id,
      workItemId: s.workItemId,
      workCode: s.workItem?.workCode ?? null,
      title: s.workItem?.title ?? null,
      repository: s.repository,
      headCommitSha: s.headCommitSha,
      pullRequestNumber: s.pullRequestNumber,
      status: s.status,
      source: s.source,
      createdAt: s.createdAt,
    })),
  }
}
