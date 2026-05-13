import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { motion } from 'motion/react'
import { ThumbsUp, ThumbsDown, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'

type Approval = { id: string; subjectType: string; subjectId: string; status: string; createdAt: string }
type AgentRunApproval = {
  id: string
  status: string
  startedAt?: string
  agent?: { name?: string | null }
  outputs?: Array<{
    structuredPayload?: {
      pendingApproval?: {
        continuation_token?: string
        tool_name?: string
        tool_args?: Record<string, unknown>
        tool_descriptor?: { risk_level?: string; execution_target?: string }
      } | null
      cfCallId?: string
      traceId?: string
    } | null
  }>
}

export function ApprovalsPage() {
  const qc = useQueryClient()
  const [agentReasons, setAgentReasons] = useState<Record<string, string>>({})
  const [agentArgs, setAgentArgs] = useState<Record<string, string>>({})

  const { data, isLoading } = useQuery({
    queryKey: ['approvals', 'my'],
    queryFn: () => api.get('/approvals/my-approvals').then(r => r.data),
    refetchInterval: 10_000,
  })
  const { data: agentApprovals, isLoading: agentApprovalsLoading } = useQuery({
    queryKey: ['agent-runs', 'pending-approval'],
    queryFn: () => api.get('/agent-runs/pending-approval').then(r => r.data),
    refetchInterval: 10_000,
  })

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: string }) =>
      api.post(`/approvals/${id}/decision`, { decision }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  })
  const decideAgentRun = useMutation({
    mutationFn: ({ id, decision, reason, argsText }: { id: string; decision: 'approved' | 'rejected'; reason?: string; argsText?: string }) => {
      let args_override: Record<string, unknown> | undefined
      if (argsText?.trim()) {
        args_override = JSON.parse(argsText)
      }
      return api.post(`/agent-runs/${id}/approve`, { decision, reason, args_override })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-runs', 'pending-approval'] })
      qc.invalidateQueries({ queryKey: ['approvals'] })
    },
  })

  const approvals: Approval[] = data?.content ?? (Array.isArray(data) ? data : [])
  const pendingAgentRuns: AgentRunApproval[] = agentApprovals?.content ?? (Array.isArray(agentApprovals) ? agentApprovals : [])
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

  function AgentRunApprovalRow({ run }: { run: AgentRunApproval }) {
    const pending = run.outputs?.[0]?.structuredPayload?.pendingApproval ?? null
    const toolName = pending?.tool_name ?? 'tool call'
    const risk = pending?.tool_descriptor?.risk_level ?? 'approval'
    const args = pending?.tool_args ?? {}
    const argsText = agentArgs[run.id] ?? JSON.stringify(args, null, 2)
    const reason = agentReasons[run.id] ?? ''
    return (
      <div className="glass-card rounded-xl p-4" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-start gap-3">
          <div className="w-1 h-10 rounded-full shrink-0 mt-0.5" style={{ background: '#f97316' }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-200">Agent tool approval</p>
            <p className="text-xs text-slate-500 truncate">
              {run.agent?.name ?? 'Agent run'} wants to run <span className="font-mono text-slate-400">{toolName}</span>
            </p>
            <p className="text-xs font-mono text-slate-600 truncate">
              {pending?.continuation_token ?? run.id}
            </p>
            <p className="text-xs text-slate-600 mt-0.5">
              {risk} · {run.startedAt ? new Date(run.startedAt).toLocaleString() : 'paused'}
            </p>
            <div className="mt-3 grid gap-2">
              <label className="text-xs text-slate-500">
                Reason
                <input
                  className="mt-1 w-full rounded-lg bg-slate-950/70 border border-slate-800 px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-500"
                  value={reason}
                  onChange={(e) => setAgentReasons(prev => ({ ...prev, [run.id]: e.target.value }))}
                  placeholder="Why this tool call is approved or rejected"
                />
              </label>
              <label className="text-xs text-slate-500">
                Tool arguments
                <textarea
                  className="mt-1 w-full min-h-24 rounded-lg bg-slate-950/70 border border-slate-800 px-3 py-2 text-xs text-slate-200 font-mono outline-none focus:border-cyan-500"
                  value={argsText}
                  onChange={(e) => setAgentArgs(prev => ({ ...prev, [run.id]: e.target.value }))}
                  spellCheck={false}
                />
              </label>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="w-7 h-7 flex items-center justify-center rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-colors"
              onClick={() => decideAgentRun.mutate({ id: run.id, decision: 'approved', reason, argsText })}
              disabled={decideAgentRun.isPending}
              title="Approve agent tool call"
            >
              {decideAgentRun.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ThumbsUp className="w-3.5 h-3.5" />}
            </button>
            <button
              className="w-7 h-7 flex items-center justify-center rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
              onClick={() => decideAgentRun.mutate({ id: run.id, decision: 'rejected', reason, argsText })}
              disabled={decideAgentRun.isPending}
              title="Reject agent tool call"
            >
              <ThumbsDown className="w-3.5 h-3.5" />
            </button>
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
        <p className="text-sm text-slate-500 font-mono">{pending.length + pendingAgentRuns.length} pending · {decided.length} decided</p>
      </motion.div>

      {isLoading || agentApprovalsLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton h-16 rounded-xl" />)}
        </div>
      ) : (
        <div className="space-y-4">
          {pendingAgentRuns.length > 0 && (
            <section>
              <p className="label-xs mb-2 px-1">Agent tool approvals</p>
              <div className="space-y-2">
                {pendingAgentRuns.map((run, i) => (
                  <motion.div key={run.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}>
                    <AgentRunApprovalRow run={run} />
                  </motion.div>
                ))}
              </div>
            </section>
          )}

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

          {approvals.length === 0 && pendingAgentRuns.length === 0 && (
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
