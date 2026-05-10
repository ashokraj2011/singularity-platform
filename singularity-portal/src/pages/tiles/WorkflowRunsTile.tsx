import { useQuery } from '@tanstack/react-query'
import { workgraphApi } from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { ListRow, EmptyState, ErrorState, LoadingDots, StatGrid, Stat } from '@/components/ui/Tile'
import { env } from '@/lib/env'

interface Instance {
  id: string
  name: string
  status: string
  templateId: string | null
  createdAt: string
  updatedAt: string
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])

export function WorkflowRunsTile() {
  const q = useQuery<Instance[]>({
    queryKey: ['workflow-instances'],
    queryFn: async () => {
      // Workgraph doesn't have a top-level "list instances" endpoint, so we
      // list templates and pull recent runs from each. Cheap fallback for v0.
      const tpl = await workgraphApi.get<{ data?: unknown; items?: unknown }>('/workflow-templates')
      const templates: { id: string }[] = Array.isArray(tpl.data)
        ? (tpl.data as { id: string }[])
        : ((tpl.data as { data?: { id: string }[] }).data ?? (tpl.data as { items?: { id: string }[] }).items ?? [])
      const runs: Instance[] = []
      for (const t of templates.slice(0, 10)) {
        try {
          const r = await workgraphApi.get<Instance[]>(`/workflow-templates/${t.id}/runs`)
          if (Array.isArray(r.data)) runs.push(...r.data)
        } catch { /* ignore one-off failures */ }
      }
      return runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    },
    refetchInterval: 30_000,
  })

  const runs = q.data ?? []
  const active = runs.filter((r) => !TERMINAL.has(r.status))
  const completed = runs.filter((r) => r.status === 'COMPLETED')
  const failed = runs.filter((r) => r.status === 'FAILED')

  return (
    <Card>
      <CardHeader
        title="Workflow runs"
        subtitle="Recent activity across templates"
        action={
          <a
            className="text-xs font-medium transition-colors"
            style={{ color: '#00843D' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#006236')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#00843D')}
            href={`${env.links.workgraphDesigner}`}
            target="_blank"
            rel="noreferrer"
          >
            Open workgraph →
          </a>
        }
      />
      <CardBody>
        {q.isLoading ? (
          <LoadingDots />
        ) : q.isError ? (
          <ErrorState message={(q.error as Error).message ?? 'Failed to load workflow runs'} />
        ) : (
          <>
            <StatGrid>
              <Stat label="Active" value={active.length} />
              <Stat label="Completed" value={completed.length} hint={failed.length ? `${failed.length} failed` : undefined} />
            </StatGrid>
            <div className="mt-4">
              <div className="mb-2 text-[10px] uppercase tracking-widest font-semibold" style={{ color: '#64748b' }}>
                Most recent
              </div>
              {runs.length ? (
                runs.slice(0, 5).map((r) => (
                  <ListRow
                    key={r.id}
                    left={<span className="font-medium">{r.name}</span>}
                    right={
                      <span style={{ color: r.status === 'FAILED' ? '#b91c1c' : undefined }}>{r.status}</span>
                    }
                  />
                ))
              ) : (
                <EmptyState>No runs yet. Design a workflow in workgraph to get started.</EmptyState>
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  )
}
