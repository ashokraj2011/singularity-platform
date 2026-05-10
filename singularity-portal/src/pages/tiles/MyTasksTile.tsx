import { useQuery } from '@tanstack/react-query'
import { workgraphApi } from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Stat, StatGrid, ListRow, EmptyState, ErrorState, LoadingDots } from '@/components/ui/Tile'
import { env } from '@/lib/env'

interface InboxItem {
  kind: 'task' | 'approval' | 'consumable'
  id: string
  title: string
  workflowName?: string | null
  nodeLabel?: string | null
  status: string
  createdAt: string
}

interface InboxResponse {
  counts: { mine: number; available: number; done: number }
  mine: InboxItem[]
  available: InboxItem[]
  done: InboxItem[]
}

export function MyTasksTile() {
  const q = useQuery<InboxResponse>({
    queryKey: ['runtime', 'inbox'],
    queryFn: async () => (await workgraphApi.get<InboxResponse>('/runtime/inbox')).data,
    refetchInterval: 30_000,
  })

  return (
    <Card>
      <CardHeader
        title="My open tasks"
        subtitle="Across workflows, approvals, and consumables"
        action={
          <a
            className="text-xs font-medium transition-colors"
            style={{ color: '#00843D' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#006236')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#00843D')}
            href={`${env.links.workgraphDesigner}/runtime`}
            target="_blank"
            rel="noreferrer"
          >
            Open inbox →
          </a>
        }
      />
      <CardBody>
        {q.isLoading ? (
          <LoadingDots />
        ) : q.isError ? (
          <ErrorState message={(q.error as Error).message ?? 'Failed to load inbox'} />
        ) : (
          <>
            <StatGrid>
              <Stat label="Mine" value={q.data?.counts.mine ?? 0} />
              <Stat label="Available" value={q.data?.counts.available ?? 0} />
            </StatGrid>
            <div className="mt-4">
              <div className="mb-2 text-[10px] uppercase tracking-widest font-semibold" style={{ color: '#64748b' }}>
                Mine — most recent
              </div>
              {q.data?.mine?.length ? (
                <div>
                  {q.data.mine.slice(0, 5).map((it) => (
                    <ListRow
                      key={it.id}
                      left={
                        <span>
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest font-semibold"
                            style={{ background: '#E2E8F0', color: '#475569' }}
                          >
                            {it.kind}
                          </span>{' '}
                          <span className="ml-2 font-medium">{it.title}</span>
                          {it.workflowName && <span className="ml-2" style={{ color: '#94a3b8' }}>· {it.workflowName}</span>}
                        </span>
                      }
                      right={it.status}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState>No tasks assigned. Available work shows in workgraph.</EmptyState>
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  )
}
