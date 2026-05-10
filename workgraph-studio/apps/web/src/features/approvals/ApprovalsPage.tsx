import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ThumbsUp, ThumbsDown, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'

type Approval = { id: string; subjectType: string; subjectId: string; status: string; createdAt: string }

export function ApprovalsPage() {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['approvals', 'my'],
    queryFn: () => api.get('/approvals/my-approvals').then(r => r.data),
    refetchInterval: 10_000,
  })

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: string }) =>
      api.post(`/approvals/${id}/decision`, { decision }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  })

  const approvals: Approval[] = data?.content ?? (Array.isArray(data) ? data : [])
  const pending = approvals.filter(a => a.status === 'PENDING')
  const decided = approvals.filter(a => a.status !== 'PENDING')

  const statusColor: Record<string, string> = {
    PENDING: '#f59e0b',
    APPROVED: '#10b981',
    REJECTED: '#ef4444',
    APPROVED_WITH_CONDITIONS: '#22d3ee',
    DEFERRED: '#64748b',
  }

  function ApprovalRow({ a }: { a: Approval }) {
    const color = statusColor[a.status] ?? '#64748b'
    return (
      <div className="glass-card rounded-xl p-4" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-start gap-3">
          <div className="w-1 h-10 rounded-full shrink-0 mt-0.5" style={{ background: color }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-200">{a.subjectType}</p>
            <p className="text-xs font-mono text-slate-500 truncate">{a.subjectId}</p>
            <p className="text-xs text-slate-600 mt-0.5">{new Date(a.createdAt).toLocaleDateString()}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-mono px-2 py-0.5 rounded-md"
              style={{ background: `${color}15`, color, border: `1px solid ${color}25` }}>
              {a.status}
            </span>
            {a.status === 'PENDING' && (
              <>
                <button
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                  onClick={() => decide.mutate({ id: a.id, decision: 'APPROVED' })}
                  disabled={decide.isPending}
                  title="Approve"
                >
                  {decide.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ThumbsUp className="w-3.5 h-3.5" />}
                </button>
                <button
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
                  onClick={() => decide.mutate({ id: a.id, decision: 'REJECTED' })}
                  disabled={decide.isPending}
                  title="Reject"
                >
                  <ThumbsDown className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <ThumbsUp className="w-5 h-5" style={{ color: '#22d3ee' }} />
          <h1 className="page-header">Approvals</h1>
        </div>
        <p className="text-sm text-slate-500 font-mono">{pending.length} pending · {decided.length} decided</p>
      </motion.div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton h-16 rounded-xl" />)}
        </div>
      ) : (
        <div className="space-y-4">
          {pending.length > 0 && (
            <section>
              <p className="label-xs mb-2 px-1">Awaiting decision</p>
              <div className="space-y-2">
                {pending.map((a, i) => (
                  <motion.div key={a.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}>
                    <ApprovalRow a={a} />
                  </motion.div>
                ))}
              </div>
            </section>
          )}

          {decided.length > 0 && (
            <section>
              <p className="label-xs mb-2 px-1 mt-4">Decided</p>
              <div className="space-y-2 opacity-70">
                {decided.slice(0, 5).map(a => <ApprovalRow key={a.id} a={a} />)}
              </div>
            </section>
          )}

          {approvals.length === 0 && (
            <div className="glass-panel rounded-xl py-16 text-center">
              <ThumbsUp className="w-10 h-10 text-slate-700 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">No pending approvals</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
