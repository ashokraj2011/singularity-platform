import { useQuery } from '@tanstack/react-query'
import { contextFabricApi } from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Stat, StatGrid, ErrorState, LoadingDots, EmptyState } from '@/components/ui/Tile'

interface Dashboard {
  total_runs?: number
  total_sessions?: number
  total_tokens_saved?: number
  total_cost_saved?: number
  average_percent_saved?: number
  best_mode?: string
}

const fmtNumber = new Intl.NumberFormat('en-US')
const fmtUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })

export function TokenSavingsTile() {
  const q = useQuery<Dashboard>({
    queryKey: ['cf', 'metrics', 'dashboard'],
    queryFn: async () => (await contextFabricApi.get<Dashboard>('/metrics/dashboard')).data,
    refetchInterval: 60_000,
  })

  return (
    <Card>
      <CardHeader title="LLM cost & token savings" subtitle="context-fabric metrics-ledger" />
      <CardBody>
        {q.isLoading ? (
          <LoadingDots />
        ) : q.isError ? (
          <ErrorState message={(q.error as Error).message ?? 'Failed to load metrics'} />
        ) : !q.data || !q.data.total_runs ? (
          <EmptyState>No LLM calls recorded yet. Run a workflow with an AGENT_TASK to populate.</EmptyState>
        ) : (
          <>
            <StatGrid>
              <Stat
                label="Tokens saved"
                value={fmtNumber.format(q.data.total_tokens_saved ?? 0)}
                hint={`${(q.data.average_percent_saved ?? 0).toFixed(1)}% avg`}
              />
              <Stat
                label="Cost saved"
                value={fmtUsd.format(q.data.total_cost_saved ?? 0)}
                hint={q.data.best_mode ? `best mode: ${q.data.best_mode}` : undefined}
              />
              <Stat label="Runs" value={fmtNumber.format(q.data.total_runs ?? 0)} />
              <Stat label="Sessions" value={fmtNumber.format(q.data.total_sessions ?? 0)} />
            </StatGrid>
          </>
        )}
      </CardBody>
    </Card>
  )
}
