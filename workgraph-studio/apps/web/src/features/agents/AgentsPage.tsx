import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Bot, CheckCircle, XCircle, Loader2, AlertCircle } from 'lucide-react'
import { api } from '../../lib/api'

type Agent = { id: string; name: string; description?: string; model: string; isActive: boolean }
type AgentRun = { id: string; agentId: string; status: string; agent?: { name: string } }

export function AgentsPage() {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get('/agents').then(r => r.data),
  })

  const { data: pendingReview } = useQuery({
    queryKey: ['agent-runs', 'pending-review'],
    queryFn: () => api.get('/agent-runs/pending-review').then(r => r.data),
    refetchInterval: 8_000,
  })

  const review = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: string }) =>
      api.post(`/agent-runs/${id}/review`, { decision }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-runs'] })
    },
  })

  const items: Agent[] = data?.content ?? (Array.isArray(data) ? data : [])
  const pendingRuns: AgentRun[] = pendingReview?.content ?? []

  return (
    <div className="p-6 max-w-4xl">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Bot className="w-5 h-5" style={{ color: '#22d3ee' }} />
          <h1 className="page-header">Agents</h1>
        </div>
        <p className="text-sm text-slate-500 font-mono">
          {items.filter(a => a.isActive).length} active · {items.length} registered
        </p>
      </motion.div>

      {/* Pending review alert */}
      {pendingRuns.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 rounded-xl p-4"
          style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)' }}
        >
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle className="w-4 h-4 text-yellow-400" />
            <p className="text-sm font-semibold text-yellow-300">{pendingRuns.length} agent run(s) awaiting human review</p>
          </div>
          <div className="space-y-2">
            {pendingRuns.slice(0, 3).map(run => (
              <div key={run.id} className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono text-slate-400">{run.agent?.name ?? run.agentId}</span>
                  <span className="text-xs text-slate-600 ml-2">· {run.id.slice(0, 8)}…</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                    style={{ border: '1px solid rgba(52,211,153,0.2)' }}
                    onClick={() => review.mutate({ id: run.id, decision: 'APPROVED' })}
                    disabled={review.isPending}
                  >
                    {review.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                    Approve
                  </button>
                  <button
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
                    style={{ border: '1px solid rgba(239,68,68,0.2)' }}
                    onClick={() => review.mutate({ id: run.id, decision: 'REJECTED' })}
                    disabled={review.isPending}
                  >
                    <XCircle className="w-3 h-3" />
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Agent grid */}
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-24 rounded-xl" />)}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((agent, i) => (
            <motion.div
              key={agent.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: i * 0.05 }}
              className="glass-card rounded-xl p-4 hover:bg-white/[0.03] transition-all duration-200"
              style={{ border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <div className="flex items-start gap-3">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: agent.isActive ? 'rgba(34,211,238,0.1)' : 'rgba(100,116,139,0.1)', border: `1px solid ${agent.isActive ? 'rgba(34,211,238,0.2)' : 'rgba(100,116,139,0.2)'}` }}
                >
                  <Bot className="w-4 h-4" style={{ color: agent.isActive ? '#22d3ee' : '#64748b' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-200 truncate">{agent.name}</p>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <span className={`status-dot ${agent.isActive ? 'active' : ''}`}
                        style={!agent.isActive ? { background: '#475569' } : {}} />
                      <span className="text-xs font-mono" style={{ color: agent.isActive ? '#10b981' : '#64748b' }}>
                        {agent.isActive ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 truncate">{agent.description}</p>
                  <p className="text-xs font-mono text-slate-600 mt-1">{agent.model}</p>
                </div>
              </div>
            </motion.div>
          ))}
          {items.length === 0 && (
            <div className="col-span-full glass-panel rounded-xl py-16 text-center">
              <Bot className="w-10 h-10 text-slate-700 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">No agents configured</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
