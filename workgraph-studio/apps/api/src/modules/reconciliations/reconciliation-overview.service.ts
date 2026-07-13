import { prisma } from '../../lib/prisma'

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

export async function getReconciliationOverview(limit = 25) {
  const take = Math.min(Math.max(limit, 1), 100)
  const [runs, submissions, runGroups, submissionGroups] = await Promise.all([
    prisma.reconciliationRun.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      include: { workItem: { select: { workCode: true, title: true } } },
    }),
    prisma.implementationSubmission.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      include: { workItem: { select: { workCode: true, title: true } } },
    }),
    prisma.reconciliationRun.groupBy({ by: ['status'], _count: true }),
    prisma.implementationSubmission.groupBy({ by: ['status'], _count: true }),
  ])

  return {
    summary: {
      reconciliations: tallyByStatus(runGroups as StatusGroup[]),
      submissions: tallyByStatus(submissionGroups as StatusGroup[]),
    },
    recentReconciliations: runs.map((r) => ({
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
    recentSubmissions: submissions.map((s) => ({
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
