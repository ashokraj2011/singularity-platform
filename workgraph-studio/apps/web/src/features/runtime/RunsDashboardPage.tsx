import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  GitFork, Search, Filter, Workflow as WorkflowIcon,
  ChevronRight, Activity, CheckCircle2, AlertCircle, Pause, Clock,
} from 'lucide-react'
import { api } from '../../lib/api'

/**
 * Cross-workflow Runs dashboard.
 *
 * Lists every run the user can see — independent of which workflow each came
 * from — with live status, progress, and a quick "Open" link into either the
 * step-by-step viewer or the full canvas studio.  Auto-refreshes so live
 * progress is visible without reloading.
 */

type RunRow = {
  id: string
  name: string
  status: string
  templateId?: string | null
  templateVersion?: number | null
  createdAt: string
  startedAt?: string | null
  completedAt?: string | null
  archivedAt?: string | null
  /** 'server' = legacy server-side run; 'browser' = browser-runtime snapshot. */
  source?: 'server' | 'browser'
}

type Workflow = {
  id: string
  name: string
  capabilityId?: string | null
}

const STATUS_VISUAL: Record<string, { fg: string; bg: string; border: string; Icon: React.ElementType }> = {
  DRAFT:     { fg: '#64748b', bg: 'rgba(100,116,139,0.10)', border: 'rgba(100,116,139,0.25)', Icon: Clock },
  ACTIVE:    { fg: '#22c55e', bg: 'rgba(34,197,94,0.10)',   border: 'rgba(34,197,94,0.30)',   Icon: Activity },
  PAUSED:    { fg: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.25)',  Icon: Pause },
  COMPLETED: { fg: '#0ea5e9', bg: 'rgba(14,165,233,0.10)',  border: 'rgba(14,165,233,0.25)',  Icon: CheckCircle2 },
  FAILED:    { fg: '#ef4444', bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.25)',   Icon: AlertCircle },
  CANCELLED: { fg: '#94a3b8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.25)', Icon: Pause },
}

export function RunsDashboardPage() {
  const navigate = useNavigate()
  const [search, setSearch]           = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [workflowFilter, setWorkflowFilter] = useState<string>('all')

  // Pull every server-side instance the API lets us see.  The endpoint already
  // filters out design instances by virtue of the schema refactor, so what we
  // get back is real runs.
  const { data: instancesData, isLoading: serverLoading } = useQuery({
    queryKey: ['runs-dashboard', 'instances'],
    queryFn:  () => api.get('/workflow-instances').then(r => r.data),
    refetchInterval: 5_000,
  })
  const serverRuns: RunRow[] = (Array.isArray(instancesData)
    ? instancesData
    : Array.isArray(instancesData?.content) ? instancesData.content : []
  ).map((r: any) => ({ ...r, source: 'server' as const }))

  // Browser-runtime snapshots — server is just storage; the runtime ran client-side.
  const { data: snapshotsData, isLoading: snapsLoading } = useQuery({
    queryKey: ['runs-dashboard', 'snapshots'],
    queryFn:  () => api.get('/runs', { params: { mine: 'true' } }).then(r => r.data),
    refetchInterval: 5_000,
  })
  const browserRuns: RunRow[] = Array.isArray(snapshotsData)
    ? snapshotsData.map((s: any) => ({
        id:               s.runId,
        name:             s.name,
        status:           s.status,
        templateId:       s.workflowId,
        templateVersion:  s.payload?.workflowVersionHash ?? null,
        createdAt:        s.createdAt,
        startedAt:        s.payload?.startedAt ?? s.createdAt,
        completedAt:      s.status === 'COMPLETED' ? s.updatedAt : null,
        source:           'browser' as const,
      }))
    : []

  const isLoading = serverLoading || snapsLoading
  const runs: RunRow[] = useMemo(
    () => [...browserRuns, ...serverRuns].sort((a, b) =>
      (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt),
    ),
    [serverRuns, browserRuns],
  )

  // Workflow names for the per-row breadcrumb + filter.
  const { data: workflowsData } = useQuery({
    queryKey: ['runs-dashboard', 'workflows'],
    queryFn:  () => api.get('/workflow-templates').then(r => r.data),
    staleTime: 60_000,
  })
  const workflows: Workflow[] = Array.isArray(workflowsData)
    ? workflowsData
    : Array.isArray(workflowsData?.content) ? workflowsData.content : []
  const workflowById = useMemo(() => Object.fromEntries(workflows.map(w => [w.id, w])), [workflows])

  // Counts (for the summary chips at the top)
  const counts = useMemo(() => {
    const c = { total: runs.length, active: 0, completed: 0, failed: 0, paused: 0, draft: 0 }
    for (const r of runs) {
      if (r.status === 'ACTIVE')    c.active++
      if (r.status === 'COMPLETED') c.completed++
      if (r.status === 'FAILED')    c.failed++
      if (r.status === 'PAUSED')    c.paused++
      if (r.status === 'DRAFT')     c.draft++
    }
    return c
  }, [runs])

  // Filtering
  const filtered = useMemo(() => {
    return runs
      .filter(r => !r.archivedAt)
      .filter(r => statusFilter === 'all' || r.status === statusFilter)
      .filter(r => workflowFilter === 'all' || r.templateId === workflowFilter)
      .filter(r => {
        if (!search.trim()) return true
        const q = search.toLowerCase()
        return r.name.toLowerCase().includes(q)
            || (workflowById[r.templateId ?? '']?.name ?? '').toLowerCase().includes(q)
      })
  }, [runs, statusFilter, workflowFilter, search, workflowById])

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'rgba(14,165,233,0.10)', border: '1px solid rgba(14,165,233,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0ea5e9',
        }}>
          <GitFork size={18} />
        </div>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-on-surface)', margin: 0, letterSpacing: '-0.01em' }}>
            Runs
          </h1>
          <p style={{ fontSize: 12, color: 'var(--color-outline)', margin: 0 }}>
            Live executions across every workflow your team owns. Open any run to take control and complete it.
          </p>
        </div>
      </div>

      {/* Summary chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <Chip label="Total"     value={counts.total}     color="#0f172a" />
        <Chip label="Active"    value={counts.active}    color="#22c55e" />
        <Chip label="Paused"    value={counts.paused}    color="#f59e0b" />
        <Chip label="Completed" value={counts.completed} color="#0ea5e9" />
        <Chip label="Failed"    value={counts.failed}    color="#ef4444" />
        <Chip label="Draft"     value={counts.draft}     color="#64748b" />
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={12} style={{ position: 'absolute', top: '50%', left: 10, transform: 'translateY(-50%)', color: 'var(--color-outline)' }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search runs by name or workflow…"
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '8px 12px 8px 30px', borderRadius: 8,
              border: '1px solid var(--color-outline-variant)', background: '#fff',
              fontSize: 13, outline: 'none',
            }}
          />
        </div>
        <Filter size={12} style={{ color: 'var(--color-outline)' }} />
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          style={{
            padding: '7px 10px', borderRadius: 8,
            border: '1px solid var(--color-outline-variant)', background: '#fff',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', outline: 'none',
          }}
        >
          <option value="all">All statuses</option>
          {['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select
          value={workflowFilter}
          onChange={e => setWorkflowFilter(e.target.value)}
          style={{
            padding: '7px 10px', borderRadius: 8,
            border: '1px solid var(--color-outline-variant)', background: '#fff',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', outline: 'none',
            maxWidth: 220,
          }}
        >
          <option value="all">All workflows</option>
          {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>

      {/* List */}
      {isLoading ? (
        <p style={{ fontSize: 13, color: 'var(--color-outline)' }}>Loading runs…</p>
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(r => (
            <RunRowCard
              key={`${r.source ?? 'server'}-${r.id}`}
              run={r}
              workflow={r.templateId ? workflowById[r.templateId] : null}
              onOpen={() => navigate(r.source === 'browser' ? `/play/${r.id}` : `/runs/${r.id}`)}
              onOpenCanvas={() => navigate(r.source === 'browser' ? `/play/${r.id}` : `/workflow/${r.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function Chip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '6px 12px', borderRadius: 9,
      background: '#fff', border: '1px solid var(--color-outline-variant)',
    }}>
      <span style={{ fontSize: 11, color: 'var(--color-outline)', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 800, color }}>{value}</span>
    </div>
  )
}

function RunRowCard({
  run, workflow, onOpen, onOpenCanvas,
}: {
  run: RunRow
  workflow: Workflow | null
  onOpen: () => void
  onOpenCanvas: () => void
}) {
  const v = STATUS_VISUAL[run.status] ?? STATUS_VISUAL.DRAFT
  const startedAt   = run.startedAt   ? new Date(run.startedAt).toLocaleString()   : null
  const completedAt = run.completedAt ? new Date(run.completedAt).toLocaleString() : null
  const createdAt   = new Date(run.createdAt).toLocaleString()

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '12px 16px', borderRadius: 11,
        background: '#fff', border: '1px solid var(--color-outline-variant)',
      }}
    >
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        background: v.bg, border: `1px solid ${v.border}`, color: v.fg,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <v.Icon size={14} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {run.name}
          </span>
          <span style={{
            fontSize: 9, fontWeight: 700, color: v.fg, background: v.bg,
            padding: '2px 6px', borderRadius: 4,
            letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'monospace',
          }}>
            {run.status}
          </span>
          {typeof run.templateVersion === 'number' && (
            <span title={`Cloned from design v${run.templateVersion}`} style={{
              fontSize: 9, fontWeight: 700, color: '#6366f1',
              background: 'rgba(99,102,241,0.10)', border: '1px solid rgba(99,102,241,0.20)',
              padding: '2px 6px', borderRadius: 4, fontFamily: 'monospace',
            }}>
              v{run.templateVersion}
            </span>
          )}
          {run.source === 'browser' && (
            <span title="Runs entirely in the browser; server stores snapshots only." style={{
              fontSize: 9, fontWeight: 700, color: '#0ea5e9',
              background: 'rgba(14,165,233,0.10)', border: '1px solid rgba(14,165,233,0.25)',
              padding: '2px 6px', borderRadius: 4, letterSpacing: '0.10em', textTransform: 'uppercase',
            }}>
              Browser
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
          {workflow && (
            <span style={{ fontSize: 11, color: 'var(--color-outline)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <WorkflowIcon size={11} /> {workflow.name}
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--color-outline)' }}>
            {completedAt ? `Completed ${completedAt}` : startedAt ? `Started ${startedAt}` : `Created ${createdAt}`}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button
          onClick={onOpenCanvas}
          title="Open the live graph in the studio"
          style={btnSecondary()}
        >
          Canvas
        </button>
        <button
          onClick={onOpen}
          title="Open the step-by-step run viewer"
          style={btnPrimary()}
        >
          Open <ChevronRight size={11} />
        </button>
      </div>
    </motion.div>
  )
}

function EmptyState() {
  return (
    <div style={{
      padding: '48px 16px', textAlign: 'center',
      borderRadius: 12, border: '1px dashed var(--color-outline-variant)', background: '#fafafa',
    }}>
      <GitFork size={32} style={{ color: 'var(--color-outline)', opacity: 0.5, marginBottom: 8 }} />
      <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-on-surface)', marginBottom: 4 }}>
        No runs match these filters
      </p>
      <p style={{ fontSize: 12, color: 'var(--color-outline)' }}>
        Start a run from the Workflows page to see it appear here.
      </p>
    </div>
  )
}

function btnPrimary(): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '6px 12px', borderRadius: 8, border: 'none',
    background: 'var(--color-primary)', color: '#fff',
    fontSize: 12, fontWeight: 700, cursor: 'pointer',
  }
}
function btnSecondary(): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '6px 12px', borderRadius: 8,
    border: '1px solid var(--color-outline-variant)', background: '#fff',
    color: 'var(--color-on-surface)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
  }
}
