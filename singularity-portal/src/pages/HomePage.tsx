import { MyTasksTile } from './tiles/MyTasksTile'
import { WorkflowRunsTile } from './tiles/WorkflowRunsTile'
import { TokenSavingsTile } from './tiles/TokenSavingsTile'
import { CapabilitiesTile } from './tiles/CapabilitiesTile'
import { useAuthStore } from '@/store/auth.store'
import { Link } from 'react-router-dom'
import { ServerCog, Zap } from 'lucide-react'

export function HomePage() {
  const user = useAuthStore((s) => s.user)
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold" style={{ color: '#0A2240' }}>
          Welcome{user?.display_name ? `, ${user.display_name}` : ''}
        </h1>
        <p className="mt-1 text-sm" style={{ color: '#64748b' }}>
          Across-platform view of agents, workflows, and LLM cost.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <MyTasksTile />
        <WorkflowRunsTile />
        <TokenSavingsTile />
        <CapabilitiesTile />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Link
          to="/engine"
          className="flex items-center justify-between rounded-xl bg-white px-5 py-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          style={{ border: '1px solid #E2E8F0', borderLeft: '3px solid #d97706' }}
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg p-2" style={{ background: '#fffbeb', color: '#92400e' }}>
              <Zap className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold" style={{ color: '#0A2240' }}>Singularity Engine</div>
              <div className="mt-0.5 text-xs" style={{ color: '#64748b' }}>
                Automated failure triage, root-cause diagnosis, and eval coverage.
              </div>
            </div>
          </div>
          <span className="text-xs font-semibold" style={{ color: '#d97706' }}>Open</span>
        </Link>
        <Link
          to="/operations"
          className="flex items-center justify-between rounded-xl bg-white px-5 py-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          style={{ border: '1px solid #E2E8F0' }}
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg p-2" style={{ background: '#e6f4ed', color: '#006236' }}>
              <ServerCog className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold" style={{ color: '#0A2240' }}>Operations Command Center</div>
              <div className="mt-0.5 text-xs" style={{ color: '#64748b' }}>
                Service status, DBs, keys, endpoints, LLM routing, and MCP setup.
              </div>
            </div>
          </div>
          <span className="text-xs font-semibold" style={{ color: '#00843D' }}>Open</span>
        </Link>
      </div>
    </div>
  )
}
