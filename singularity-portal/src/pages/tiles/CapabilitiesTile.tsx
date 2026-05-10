import { useQuery } from '@tanstack/react-query'
import { iamApi } from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { ListRow, EmptyState, ErrorState, LoadingDots } from '@/components/ui/Tile'
import { env } from '@/lib/env'

interface Capability {
  id: string
  capability_id: string
  name: string
  capability_type?: string
  status?: string
  visibility?: string
}

interface CapabilityList {
  items: Capability[]
  total: number
}

export function CapabilitiesTile() {
  const q = useQuery<CapabilityList>({
    queryKey: ['iam', 'capabilities'],
    queryFn: async () => (await iamApi.get<CapabilityList>('/capabilities', { params: { size: 25 } })).data,
    refetchInterval: 60_000,
  })

  return (
    <Card>
      <CardHeader
        title="Your capabilities"
        subtitle="From Singularity IAM"
        action={
          <a
            className="text-xs font-medium transition-colors"
            style={{ color: '#00843D' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#006236')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#00843D')}
            href={env.links.iamAdmin}
            target="_blank"
            rel="noreferrer"
          >
            Manage in IAM →
          </a>
        }
      />
      <CardBody>
        {q.isLoading ? (
          <LoadingDots />
        ) : q.isError ? (
          <ErrorState message={(q.error as Error).message ?? 'Failed to load capabilities'} />
        ) : !q.data?.items?.length ? (
          <EmptyState>No capabilities visible. Ask your admin to grant membership.</EmptyState>
        ) : (
          <>
            <div className="mb-2 text-[10px] uppercase tracking-widest font-semibold" style={{ color: '#64748b' }}>
              {q.data.total} total
            </div>
            {q.data.items.slice(0, 6).map((c) => (
              <ListRow
                key={c.id}
                left={
                  <span>
                    <span className="font-medium">{c.name}</span>
                    {c.capability_type && (
                      <span
                        className="ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest font-semibold"
                        style={{ background: '#E2E8F0', color: '#475569' }}
                      >
                        {c.capability_type}
                      </span>
                    )}
                  </span>
                }
                right={c.status}
              />
            ))}
          </>
        )}
      </CardBody>
    </Card>
  )
}
