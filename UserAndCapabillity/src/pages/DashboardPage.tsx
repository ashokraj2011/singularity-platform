import { Users, Layers, UsersRound, Activity, ArrowRight } from 'lucide-react'
import { StatCard } from '@/components/StatCard'
import { PageHeader } from '@/components/PageHeader'
import { useUsers } from '@/hooks/useUsers'
import { useCapabilities } from '@/hooks/useCapabilities'
import { useTeams } from '@/hooks/useTeams'
import { useAuditEvents } from '@/hooks/useAuditEvents'
import { formatDateTime } from '@/lib/format'

const EVENT_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  user_created:       { bg: '#e6f4ed', text: '#006236' },
  user_updated:       { bg: '#e6f4ed', text: '#006236' },
  capability_created: { bg: '#ede9fe', text: '#5b21b6' },
  capability_updated: { bg: '#ede9fe', text: '#5b21b6' },
  role_assigned:      { bg: '#fef3c7', text: '#92400e' },
  authz_check:        { bg: '#e0f2fe', text: '#0c4a6e' },
}

function eventStyle(type: string) {
  return EVENT_TYPE_COLORS[type] ?? { bg: '#F0F4F8', text: '#475569' }
}

export function DashboardPage() {
  const { data: users } = useUsers({ size: 1 })
  const { data: capabilities } = useCapabilities({ size: 1 })
  const { data: teams } = useTeams({ size: 1 })
  const { data: events } = useAuditEvents({ size: 10 })

  return (
    <div className="p-8 max-w-5xl">
      <PageHeader
        title="Dashboard"
        subtitle="Overview of your Singularity IAM platform"
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Users"
          value={users?.total ?? '—'}
          icon={Users}
          iconBg="#e6f4ed"
          iconColor="#00843D"
        />
        <StatCard
          label="Capabilities"
          value={capabilities?.total ?? '—'}
          icon={Layers}
          iconBg="#ede9fe"
          iconColor="#7c3aed"
        />
        <StatCard
          label="Teams"
          value={teams?.total ?? '—'}
          icon={UsersRound}
          iconBg="#e0f2fe"
          iconColor="#0284c7"
        />
        <StatCard
          label="Audit Events"
          value={events?.total ?? '—'}
          icon={Activity}
          iconBg="#fef3c7"
          iconColor="#d97706"
        />
      </div>

      {/* Audit log */}
      <div
        className="bg-white rounded-xl overflow-hidden"
        style={{ border: '1px solid #E2E8F0', boxShadow: '0 1px 3px rgba(10,34,64,0.06)' }}
      >
        <div
          className="px-6 py-4 flex items-center justify-between"
          style={{ borderBottom: '1px solid #F0F4F8' }}
        >
          <div>
            <h2 className="text-sm font-bold" style={{ color: '#0A2240' }}>
              Recent Audit Events
            </h2>
            <p className="text-xs mt-0.5" style={{ color: '#94a3b8' }}>
              Last {events?.items.length ?? 0} events
            </p>
          </div>
          <a
            href="/audit"
            className="flex items-center gap-1 text-xs font-medium transition-colors hover:opacity-80"
            style={{ color: '#00843D' }}
          >
            View all <ArrowRight className="w-3 h-3" />
          </a>
        </div>

        {!events?.items.length ? (
          <p
            className="text-sm text-center py-10"
            style={{ color: '#94a3b8' }}
          >
            No audit events yet
          </p>
        ) : (
          <div>
            {events.items.map((ev, i) => {
              const style = eventStyle(ev.event_type)
              return (
                <div
                  key={ev.id}
                  className="px-6 py-3 flex items-center justify-between transition-colors hover:bg-[#F8FAFC]"
                  style={{ borderBottom: i < events.items.length - 1 ? '1px solid #F8FAFC' : undefined }}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="font-mono text-xs font-medium px-2.5 py-1 rounded-full whitespace-nowrap"
                      style={{ background: style.bg, color: style.text }}
                    >
                      {ev.event_type}
                    </span>
                    {ev.capability_id && (
                      <span
                        className="text-xs font-mono truncate max-w-[160px]"
                        style={{ color: '#64748b' }}
                      >
                        {ev.capability_id}
                      </span>
                    )}
                  </div>
                  <span
                    className="text-xs shrink-0 ml-4"
                    style={{ color: '#94a3b8' }}
                  >
                    {formatDateTime(ev.created_at)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
