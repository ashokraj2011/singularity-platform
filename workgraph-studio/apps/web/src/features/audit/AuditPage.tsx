import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ScrollText, Activity } from 'lucide-react'
import { api } from '../../lib/api'

type AuditEvent = {
  id: string
  eventType: string
  entityType: string
  entityId: string
  actorId?: string
  payload?: Record<string, unknown>
  occurredAt: string
}

const entityColor: Record<string, string> = {
  WORKFLOW: '#22d3ee',
  TASK: '#f59e0b',
  APPROVAL: '#10b981',
  CONSUMABLE: '#8b5cf6',
  AGENT_RUN: '#f472b6',
  TOOL_RUN: '#ef4444',
}

export function AuditPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['audit', 'events'],
    queryFn: () => api.get('/audit/events').then(r => r.data),
    refetchInterval: 10_000,
  })

  const events: AuditEvent[] = data?.content ?? []

  return (
    <div className="p-6 max-w-4xl">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <ScrollText className="w-5 h-5" style={{ color: '#22d3ee' }} />
          <h1 className="page-header">Audit</h1>
        </div>
        <p className="text-sm text-slate-500 font-mono">{events.length} events · Immutable append-only</p>
      </motion.div>

      {isLoading ? (
        <div className="space-y-1.5">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton h-12 rounded-xl" />)}
        </div>
      ) : (
        <div className="glass-card rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
          {events.length === 0 ? (
            <div className="py-16 text-center">
              <Activity className="w-10 h-10 text-slate-700 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">No audit events yet</p>
            </div>
          ) : (
            <div>
              {events.map((e, i) => {
                const color = entityColor[e.entityType] ?? '#64748b'
                return (
                  <motion.div
                    key={e.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.15, delay: Math.min(i, 10) * 0.03 }}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors"
                    style={{ borderBottom: i < events.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}
                  >
                    <span
                      className="text-xs font-mono px-2 py-0.5 rounded-md shrink-0"
                      style={{ background: `${color}12`, color, border: `1px solid ${color}18` }}
                    >
                      {e.eventType}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs text-slate-500 shrink-0">{e.entityType}</span>
                        <span className="font-mono text-xs text-slate-600 truncate">{e.entityId.slice(0, 12)}…</span>
                        {e.actorId && <span className="text-[10px] font-mono text-slate-600 truncate">by {e.actorId.slice(0, 10)}…</span>}
                      </div>
                      {e.payload && Object.keys(e.payload).length > 0 && (
                        <pre className="mt-1 max-h-20 overflow-auto rounded-lg bg-black/20 p-2 text-[10px] leading-relaxed text-slate-500">
                          {JSON.stringify(e.payload, null, 2)}
                        </pre>
                      )}
                    </div>
                    <span className="ml-auto text-xs font-mono text-slate-600 shrink-0">
                      {new Date(e.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </motion.div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
