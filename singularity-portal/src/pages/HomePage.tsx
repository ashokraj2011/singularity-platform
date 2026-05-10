import { MyTasksTile } from './tiles/MyTasksTile'
import { WorkflowRunsTile } from './tiles/WorkflowRunsTile'
import { TokenSavingsTile } from './tiles/TokenSavingsTile'
import { CapabilitiesTile } from './tiles/CapabilitiesTile'
import { useAuthStore } from '@/store/auth.store'

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
    </div>
  )
}
