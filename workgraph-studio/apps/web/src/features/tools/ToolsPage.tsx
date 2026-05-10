import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Wrench, CheckCircle, XCircle, ShieldAlert, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'

type Tool = { id: string; name: string; description?: string; riskLevel: string; requiresApproval: boolean; isActive: boolean }
type ToolRun = { id: string; toolId: string; status: string; tool?: { name: string } }

const riskConfig: Record<string, { color: string; label: string }> = {
  LOW: { color: '#10b981', label: 'LOW' },
  MEDIUM: { color: '#f59e0b', label: 'MED' },
  HIGH: { color: '#ef4444', label: 'HIGH' },
  CRITICAL: { color: '#dc2626', label: 'CRIT' },
}

export function ToolsPage() {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['tools'],
    queryFn: () => api.get('/tools').then(r => r.data),
  })

  const { data: pendingApproval } = useQuery({
    queryKey: ['tool-runs', 'pending-approval'],
    queryFn: () => api.get('/tool-runs/pending-approval').then(r => r.data),
    refetchInterval: 8_000,
  })

  const approveRun = useMutation({
    mutationFn: (id: string) => api.post(`/tool-runs/${id}/approve`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tool-runs'] }),
  })

  const rejectRun = useMutation({
    mutationFn: (id: string) => api.post(`/tool-runs/${id}/reject`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tool-runs'] }),
  })

  const items: Tool[] = data?.content ?? (Array.isArray(data) ? data : [])
  const pendingRuns: ToolRun[] = pendingApproval?.content ?? []

  return (
    <div className="p-6 max-w-4xl">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Wrench className="w-5 h-5" style={{ color: '#22d3ee' }} />
          <h1 className="page-header">Tool Gateway</h1>
        </div>
        <p className="text-sm text-slate-500 font-mono">{items.length} registered · All executions governed</p>
      </motion.div>

      {/* Pending approval alert */}
      {pendingRuns.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 rounded-xl p-4"
          style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)' }}
        >
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert className="w-4 h-4 text-red-400" />
            <p className="text-sm font-semibold text-red-300">{pendingRuns.length} tool run(s) pending approval</p>
          </div>
          <div className="space-y-2">
            {pendingRuns.slice(0, 3).map(run => (
              <div key={run.id} className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono text-slate-400">{run.tool?.name ?? run.toolId}</span>
                  <span className="text-xs text-slate-600 ml-2">· {run.id.slice(0, 8)}…</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                    style={{ border: '1px solid rgba(52,211,153,0.2)' }}
                    onClick={() => approveRun.mutate(run.id)}
                    disabled={approveRun.isPending}
                  >
                    {approveRun.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                    Approve
                  </button>
                  <button
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
                    style={{ border: '1px solid rgba(239,68,68,0.2)' }}
                    onClick={() => rejectRun.mutate(run.id)}
                    disabled={rejectRun.isPending}
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

      {/* Tools list */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-16 rounded-xl" />)}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((tool, i) => {
            const risk = riskConfig[tool.riskLevel] ?? { color: '#64748b', label: tool.riskLevel }
            return (
              <motion.div
                key={tool.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: i * 0.04 }}
                className="glass-card rounded-xl p-4 hover:bg-white/[0.02] transition-all duration-200"
                style={{ border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: `${risk.color}10`, border: `1px solid ${risk.color}20` }}>
                    <Wrench className="w-3.5 h-3.5" style={{ color: risk.color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-mono text-slate-200 truncate">{tool.name}</p>
                    <p className="text-xs text-slate-500 truncate">{tool.description}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-mono px-2 py-0.5 rounded-md"
                      style={{ background: `${risk.color}12`, color: risk.color, border: `1px solid ${risk.color}20` }}>
                      {risk.label}
                    </span>
                    {tool.requiresApproval && (
                      <span className="text-xs font-mono px-2 py-0.5 rounded-md text-slate-500"
                        style={{ background: 'rgba(100,116,139,0.1)', border: '1px solid rgba(100,116,139,0.2)' }}>
                        APPROVAL
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <span className={`status-dot ${tool.isActive ? 'active' : ''}`}
                        style={!tool.isActive ? { background: '#475569' } : {}} />
                    </span>
                  </div>
                </div>
              </motion.div>
            )
          })}
          {items.length === 0 && (
            <div className="glass-panel rounded-xl py-16 text-center">
              <Wrench className="w-10 h-10 text-slate-700 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">No tools registered</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
