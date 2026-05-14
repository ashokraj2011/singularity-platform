import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { auditGovApi } from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Stat, StatGrid, ErrorState, LoadingDots, EmptyState, ListRow } from '@/components/ui/Tile'
import {
  AlertTriangle, CheckCircle2, XCircle, ChevronRight, Zap,
  Search, Shield, Clock, BarChart3, Play, Eye, RefreshCw,
} from 'lucide-react'

/* ── Types ────────────────────────────────────────────────────────────── */

interface EngineStats {
  open_issues: number
  fix_proposed: number
  resolved_issues: number
  dismissed_issues: number
  critical_open: number
  high_open: number
  active_evaluators: number
  total_eval_runs: number
  total_eval_failures: number
  datasets: number
  dataset_examples: number
  resolved_this_week: number
}

interface EngineIssue {
  id: string
  title: string
  severity: string
  status: string
  category: string
  capability_id: string | null
  trace_count: number
  affected_pct: number | null
  first_seen_at: string
  last_seen_at: string
  error_pattern: string | null
  root_cause: Record<string, unknown> | null
  proposed_fix: Record<string, unknown> | null
  sample_trace_ids: string[]
  description: string | null
  resolution_notes: string | null
}

interface Evaluator {
  id: string
  name: string
  description: string | null
  evaluator_type: string
  enabled: boolean
  fire_count: number
  pass_count: number
  fail_count: number
  issue_id: string | null
  created_at: string
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

const fmtNum = new Intl.NumberFormat('en-US')
const fmtTime = (iso: string) => {
  const d = new Date(iso)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

const sevColor: Record<string, { bg: string; text: string; dot: string }> = {
  critical: { bg: '#fef2f2', text: '#991b1b', dot: '#dc2626' },
  high:     { bg: '#fff7ed', text: '#9a3412', dot: '#ea580c' },
  medium:   { bg: '#fffbeb', text: '#92400e', dot: '#d97706' },
  low:      { bg: '#f0fdf4', text: '#166534', dot: '#16a34a' },
}

const statusIcon: Record<string, typeof CheckCircle2> = {
  open:          AlertTriangle,
  investigating: Search,
  fix_proposed:  Zap,
  resolved:      CheckCircle2,
  dismissed:     XCircle,
}

const catIcon: Record<string, typeof Shield> = {
  tool_failure:      AlertTriangle,
  llm_error:         XCircle,
  latency_spike:     Clock,
  token_blowout:     BarChart3,
  governance_denied: Shield,
  max_steps:         RefreshCw,
  eval_failure:      Eye,
}

/* ── Main Page ────────────────────────────────────────────────────────── */

export function EnginePage() {
  const qc = useQueryClient()
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('open')

  /* Stats */
  const statsQ = useQuery<EngineStats>({
    queryKey: ['engine', 'stats'],
    queryFn: async () => (await auditGovApi.get('/engine/stats')).data,
    refetchInterval: 30_000,
  })

  /* Issues list */
  const issuesQ = useQuery<{ items: EngineIssue[] }>({
    queryKey: ['engine', 'issues', statusFilter],
    queryFn: async () => (await auditGovApi.get('/engine/issues', {
      params: { status: statusFilter === 'all' ? undefined : statusFilter, limit: 50 },
    })).data,
    refetchInterval: 30_000,
  })

  /* Issue detail */
  const detailQ = useQuery<EngineIssue>({
    queryKey: ['engine', 'issues', selectedIssue],
    queryFn: async () => (await auditGovApi.get(`/engine/issues/${selectedIssue}`)).data,
    enabled: !!selectedIssue,
  })

  /* Evaluators */
  const evalsQ = useQuery<{ items: Evaluator[] }>({
    queryKey: ['engine', 'evaluators'],
    queryFn: async () => (await auditGovApi.get('/engine/evaluators')).data,
    refetchInterval: 60_000,
  })

  /* Mutations */
  const sweepMut = useMutation({
    mutationFn: async () => (await auditGovApi.post('/engine/sweep')).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['engine'] }) },
  })

  const diagnoseMut = useMutation({
    mutationFn: async (id: string) => (await auditGovApi.post(`/engine/issues/${id}/diagnose`)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['engine'] }) },
  })

  const resolveMut = useMutation({
    mutationFn: async (id: string) => (await auditGovApi.post(`/engine/issues/${id}/resolve`, {
      create_evaluator: true,
      create_dataset: true,
    })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['engine'] })
      setSelectedIssue(null)
    },
  })

  const dismissMut = useMutation({
    mutationFn: async (id: string) => (await auditGovApi.post(`/engine/issues/${id}/dismiss`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['engine'] })
      setSelectedIssue(null)
    },
  })

  const s = statsQ.data
  const issues = issuesQ.data?.items ?? []
  const detail = detailQ.data
  const evals = evalsQ.data?.items ?? []

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: '#0A2240' }}>
            Singularity Engine
          </h1>
          <p className="mt-1 text-sm" style={{ color: '#64748b' }}>
            Automated failure triage, root-cause diagnosis, and eval coverage.
          </p>
        </div>
        <button
          onClick={() => sweepMut.mutate()}
          disabled={sweepMut.isPending}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-all hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg, #00843D 0%, #006236 100%)' }}
        >
          <Play className="w-3.5 h-3.5" />
          {sweepMut.isPending ? 'Scanning...' : 'Run Sweep'}
        </button>
      </div>

      {/* Stats row */}
      {statsQ.isLoading ? <LoadingDots /> : statsQ.isError ? (
        <ErrorState message="Failed to load Engine stats" />
      ) : s ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            label="Open Issues"
            value={s.open_issues + s.fix_proposed}
            sub={s.critical_open > 0 ? `${s.critical_open} critical` : undefined}
            accent={s.critical_open > 0 ? '#dc2626' : '#d97706'}
          />
          <StatCard
            label="Resolved (7d)"
            value={s.resolved_this_week}
            sub={`${s.resolved_issues} total`}
            accent="#16a34a"
          />
          <StatCard
            label="Active Evaluators"
            value={s.active_evaluators}
            sub={`${fmtNum.format(s.total_eval_runs)} runs`}
            accent="#2563eb"
          />
          <StatCard
            label="Eval Datasets"
            value={s.datasets}
            sub={`${fmtNum.format(s.dataset_examples)} examples`}
            accent="#7c3aed"
          />
        </div>
      ) : null}

      {/* Main content: issue list + detail panel */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        {/* Issue list (3 cols) */}
        <div className="lg:col-span-3 space-y-4">
          <Card>
            <CardHeader
              title="Issues"
              subtitle="Clustered failure patterns from production traces"
              action={
                <div className="flex gap-1">
                  {['open', 'fix_proposed', 'resolved', 'dismissed', 'all'].map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors capitalize"
                      style={{
                        background: statusFilter === s ? '#e6f4ed' : 'transparent',
                        color: statusFilter === s ? '#006236' : '#64748b',
                      }}
                    >
                      {s === 'fix_proposed' ? 'Fix proposed' : s}
                    </button>
                  ))}
                </div>
              }
            />
            <CardBody className="p-0">
              {issuesQ.isLoading ? (
                <div className="px-5 py-4"><LoadingDots /></div>
              ) : issuesQ.isError ? (
                <div className="px-5 py-4"><ErrorState message="Failed to load issues" /></div>
              ) : issues.length === 0 ? (
                <div className="px-5 py-4"><EmptyState>No issues found. Run a sweep to scan production traces.</EmptyState></div>
              ) : (
                <div className="divide-y" style={{ borderColor: '#F1F5F9' }}>
                  {issues.map((issue) => {
                    const sev = sevColor[issue.severity] ?? sevColor.low
                    const StatusIcon = statusIcon[issue.status] ?? AlertTriangle
                    const CatIcon = catIcon[issue.category] ?? AlertTriangle
                    const isSelected = selectedIssue === issue.id
                    return (
                      <button
                        key={issue.id}
                        onClick={() => setSelectedIssue(issue.id)}
                        className="w-full text-left px-5 py-3.5 flex items-start gap-3 transition-colors"
                        style={{
                          background: isSelected ? '#f0fdf4' : 'transparent',
                          borderLeft: isSelected ? '3px solid #00843D' : '3px solid transparent',
                        }}
                      >
                        <div
                          className="mt-0.5 rounded-md p-1.5 shrink-0"
                          style={{ background: sev.bg }}
                        >
                          <CatIcon className="w-3.5 h-3.5" style={{ color: sev.text }} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate" style={{ color: '#0A2240' }}>
                              {issue.title}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 mt-1">
                            <span
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase"
                              style={{ background: sev.bg, color: sev.text }}
                            >
                              <span className="w-1.5 h-1.5 rounded-full" style={{ background: sev.dot }} />
                              {issue.severity}
                            </span>
                            <span className="text-[11px]" style={{ color: '#64748b' }}>
                              {issue.trace_count} traces
                            </span>
                            <span className="text-[11px]" style={{ color: '#94a3b8' }}>
                              {fmtTime(issue.last_seen_at)}
                            </span>
                          </div>
                        </div>
                        <div className="shrink-0 mt-1 flex items-center gap-1.5">
                          <StatusIcon className="w-3.5 h-3.5" style={{ color: '#94a3b8' }} />
                          <ChevronRight className="w-3 h-3" style={{ color: '#cbd5e1' }} />
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        {/* Detail panel (2 cols) */}
        <div className="lg:col-span-2 space-y-4">
          {selectedIssue && detail ? (
            <>
              {/* Issue detail */}
              <Card>
                <CardHeader title="Issue Detail" subtitle={`ID: ${detail.id.slice(0, 8)}`} />
                <CardBody className="space-y-4">
                  <div className="text-sm font-medium" style={{ color: '#0A2240' }}>{detail.title}</div>
                  {detail.description && (
                    <p className="text-xs" style={{ color: '#64748b' }}>{detail.description}</p>
                  )}

                  <StatGrid>
                    <Stat label="Traces" value={detail.trace_count} />
                    <Stat label="Severity" value={detail.severity.toUpperCase()} />
                    <Stat label="First seen" value={fmtTime(detail.first_seen_at)} />
                    <Stat label="Last seen" value={fmtTime(detail.last_seen_at)} />
                  </StatGrid>

                  {detail.error_pattern && (
                    <div className="rounded-lg p-3 text-xs font-mono overflow-auto" style={{ background: '#1e293b', color: '#e2e8f0', maxHeight: 120 }}>
                      {detail.error_pattern}
                    </div>
                  )}

                  {detail.sample_trace_ids?.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase tracking-widest font-semibold mb-1" style={{ color: '#64748b' }}>
                        Sample Traces
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {detail.sample_trace_ids.slice(0, 6).map((tid) => (
                          <span key={tid} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono" style={{ color: '#475569' }}>
                            {tid.slice(0, 12)}…
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </CardBody>
              </Card>

              {/* Root cause / fix */}
              {detail.root_cause ? (
                <Card>
                  <CardHeader title="Root Cause Analysis" subtitle="LLM-generated diagnosis" />
                  <CardBody className="space-y-3">
                    <div className="rounded-lg p-3" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                      <div className="text-xs font-semibold mb-1" style={{ color: '#166534' }}>Root Cause</div>
                      <div className="text-xs" style={{ color: '#15803d' }}>
                        {String((detail.root_cause as Record<string, unknown>).root_cause ?? '')}
                      </div>
                    </div>
                    {detail.proposed_fix && (
                      <div className="rounded-lg p-3" style={{ background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                        <div className="text-xs font-semibold mb-1" style={{ color: '#1e40af' }}>Proposed Fix</div>
                        <div className="text-xs" style={{ color: '#2563eb' }}>
                          {String((detail.proposed_fix as Record<string, unknown>).summary ?? '')}
                        </div>
                        <div className="text-[11px] mt-1" style={{ color: '#3b82f6' }}>
                          {String((detail.proposed_fix as Record<string, unknown>).detail ?? '')}
                        </div>
                      </div>
                    )}
                  </CardBody>
                </Card>
              ) : null}

              {/* Actions */}
              <Card>
                <CardBody>
                  <div className="flex flex-wrap gap-2">
                    {detail.status !== 'resolved' && (
                      <>
                        <button
                          onClick={() => diagnoseMut.mutate(detail.id)}
                          disabled={diagnoseMut.isPending}
                          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-all hover:-translate-y-0.5"
                          style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}
                        >
                          <Search className="w-3 h-3" />
                          {diagnoseMut.isPending ? 'Analyzing...' : 'Diagnose'}
                        </button>
                        <button
                          onClick={() => resolveMut.mutate(detail.id)}
                          disabled={resolveMut.isPending}
                          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-white transition-all hover:-translate-y-0.5"
                          style={{ background: 'linear-gradient(135deg, #16a34a, #15803d)' }}
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          Resolve + Create Eval
                        </button>
                        <button
                          onClick={() => dismissMut.mutate(detail.id)}
                          disabled={dismissMut.isPending}
                          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-all hover:-translate-y-0.5"
                          style={{ background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0' }}
                        >
                          <XCircle className="w-3 h-3" />
                          Dismiss
                        </button>
                      </>
                    )}
                  </div>
                </CardBody>
              </Card>
            </>
          ) : (
            /* Evaluators panel when no issue selected */
            <Card>
              <CardHeader title="Active Evaluators" subtitle="Auto-created from resolved issues" />
              <CardBody>
                {evalsQ.isLoading ? <LoadingDots /> : evals.length === 0 ? (
                  <EmptyState>No evaluators yet. Resolve an issue to auto-create one.</EmptyState>
                ) : (
                  <div className="space-y-0">
                    {evals.slice(0, 10).map((ev) => (
                      <ListRow
                        key={ev.id}
                        left={
                          <div className="flex items-center gap-2">
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ background: ev.enabled ? '#16a34a' : '#94a3b8' }}
                            />
                            <span className="text-xs font-medium truncate">{ev.name}</span>
                            <span className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                              style={{ background: '#f0f4f8', color: '#64748b' }}>
                              {ev.evaluator_type}
                            </span>
                          </div>
                        }
                        right={
                          <div className="flex items-center gap-2 text-[10px]">
                            <span style={{ color: '#16a34a' }}>{ev.pass_count}✓</span>
                            <span style={{ color: '#dc2626' }}>{ev.fail_count}✗</span>
                          </div>
                        }
                      />
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Stat Card (top-level KPI) ──────────────────────────────────────── */

function StatCard({ label, value, sub, accent }: {
  label: string; value: number; sub?: string; accent: string
}) {
  return (
    <div
      className="rounded-xl bg-white px-4 py-3.5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
      style={{ border: '1px solid #E2E8F0', borderTop: `3px solid ${accent}` }}
    >
      <div className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: '#64748b' }}>
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums" style={{ color: '#0A2240' }}>
        {fmtNum.format(value)}
      </div>
      {sub && <div className="mt-0.5 text-[11px]" style={{ color: '#94a3b8' }}>{sub}</div>}
    </div>
  )
}
