import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import {
  GitBranch, Activity, ExternalLink, Search, Filter,
  ChevronDown, AlertTriangle, CheckCircle2, Clock, Users,
  FileCode, Layers, Tag, Globe, Info,
} from 'lucide-react'
import { api } from '../../lib/api'

// ─── Types ────────────────────────────────────────────────────────────────────

type TemplateMetadata = {
  teamName?: string
  globallyAvailable?: boolean
  workflowType?: string
  domain?: string
  criticality?: string
  executionTarget?: string
  owner?: string
  requiresApprovalToRun?: boolean
  slaHours?: number
  tags?: Array<{ key: string; value: string }>
}

type WorkflowTemplate = {
  id: string
  name: string
  description?: string
  status: string
  currentVersion: number
  createdAt: string
  updatedAt: string
  metadata?: TemplateMetadata
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
  SDLC: 'SDLC', BUSINESS: 'Business', DATA_PIPELINE: 'Data Pipeline',
  INFRASTRUCTURE: 'Infrastructure', COMPLIANCE: 'Compliance', OTHER: 'Other',
}
const TYPE_COLOR: Record<string, string> = {
  SDLC: '#6366f1', BUSINESS: '#0ea5e9', DATA_PIPELINE: '#f59e0b',
  INFRASTRUCTURE: '#8b5cf6', COMPLIANCE: '#ef4444', OTHER: '#64748b',
}
const STATUS_COLOR: Record<string, string> = {
  DRAFT: '#94a3b8', PUBLISHED: '#00843D', FINAL: '#6366f1', ARCHIVED: '#64748b',
}
const CRIT_COLOR: Record<string, string> = {
  CRITICAL: '#ef4444', HIGH: '#f97316', MEDIUM: '#f59e0b', LOW: '#22c55e',
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      display: 'inline-block', fontSize: 9, fontWeight: 700, fontFamily: 'monospace',
      textTransform: 'uppercase', letterSpacing: '0.1em',
      padding: '2px 7px', borderRadius: 5,
      background: `${color}18`, color, border: `1px solid ${color}30`,
    }}>
      {label}
    </span>
  )
}

function KpiCard({ title, value, sub, icon: Icon, color = '#00843D', delay = 0 }: {
  title: string; value: string | number; sub?: string
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>
  color?: string; delay?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay }}
      style={{
        background: '#fff', border: '1px solid var(--color-outline-variant)',
        borderRadius: 14, padding: '18px 20px',
        boxShadow: '0 2px 8px rgba(12,23,39,0.04)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 10, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${color}12`, border: `1px solid ${color}25`,
        }}>
          <Icon size={15} style={{ color }} />
        </div>
        {sub && <span style={{ fontSize: 10, color: '#64748b', fontWeight: 600 }}>{sub}</span>}
      </div>
      <p style={{ fontSize: 26, fontWeight: 800, color: 'var(--color-on-surface)', lineHeight: 1, marginBottom: 4, fontFamily: "'Public Sans', sans-serif" }}>
        {value}
      </p>
      <p style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-outline)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
        {title}
      </p>
    </motion.div>
  )
}

function SectionHeader({ children, action, onAction }: { children: React.ReactNode; action?: string; onAction?: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <div style={{ width: 3, height: 13, borderRadius: 2, background: 'var(--color-primary)', opacity: 0.7 }} />
        <h2 style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-on-surface)', textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: "'Public Sans', sans-serif" }}>
          {children}
        </h2>
      </div>
      {action && onAction && (
        <button onClick={onAction} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          {action} <ExternalLink size={10} />
        </button>
      )}
    </div>
  )
}

// ─── Type distribution bar ───────────────────────────────────────────────────

function TypeBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-on-surface)' }}>{label}</span>
        <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--color-outline)' }}>{count} · {pct}%</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: 'var(--color-outline-variant)', overflow: 'hidden' }}>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          style={{ height: '100%', borderRadius: 3, background: color }}
        />
      </div>
    </div>
  )
}

// ─── Workflow row ─────────────────────────────────────────────────────────────

function WorkflowRow({ tmpl, onOpen }: { tmpl: WorkflowTemplate; onOpen: () => void }) {
  const type = tmpl.metadata?.workflowType ?? 'OTHER'
  const crit = tmpl.metadata?.criticality
  const owner = tmpl.metadata?.owner ?? tmpl.metadata?.teamName ?? '—'
  const updated = new Date(tmpl.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
  const statusColor = STATUS_COLOR[tmpl.status] ?? '#64748b'

  return (
    <div
      onClick={onOpen}
      style={{
        display: 'grid', gridTemplateColumns: '1fr 100px 82px 74px 130px 68px 32px',
        alignItems: 'center', gap: 12,
        padding: '10px 16px', cursor: 'pointer',
        borderTop: '1px solid var(--color-outline-variant)',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,132,61,0.03)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {/* Name */}
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tmpl.name}
        </p>
        {tmpl.description && (
          <p style={{ fontSize: 10, color: 'var(--color-outline)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
            {tmpl.description}
          </p>
        )}
      </div>
      {/* Type */}
      <Pill label={TYPE_LABEL[type] ?? type} color={TYPE_COLOR[type] ?? '#64748b'} />
      {/* Status */}
      <Pill label={tmpl.status} color={statusColor} />
      {/* Criticality */}
      {crit ? <Pill label={crit} color={CRIT_COLOR[crit] ?? '#64748b'} /> : <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>—</span>}
      {/* Owner / Team */}
      <span style={{ fontSize: 11, color: 'var(--color-outline)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {owner}
      </span>
      {/* Updated */}
      <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-outline)' }}>{updated}</span>
      {/* Open */}
      <ExternalLink size={12} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState<string>('ALL')
  const [filterStatus, setFilterStatus] = useState<string>('ALL')
  const [showFilterMenu, setShowFilterMenu] = useState(false)

  const { data: templatesData, isLoading } = useQuery({
    queryKey: ['workflow-templates-dashboard'],
    queryFn: () => api.get('/workflow-templates').then(r => r.data),
    refetchInterval: 30_000,
  })

  const { data: instancesData } = useQuery({
    queryKey: ['workflow-instances-dashboard'],
    queryFn: () => api.get('/workflow-instances').then(r => r.data),
    refetchInterval: 30_000,
  })

  const templates: WorkflowTemplate[] = Array.isArray(templatesData)
    ? templatesData
    : (templatesData?.content ?? [])

  const instances: Array<{ status: string; templateId?: string }> = Array.isArray(instancesData)
    ? instancesData
    : (instancesData?.content ?? [])

  // ── Derived KPIs ──
  const total = templates.length
  const published = templates.filter(t => t.status === 'PUBLISHED').length
  const draft = templates.filter(t => t.status === 'DRAFT').length
  const critical = templates.filter(t => t.metadata?.criticality === 'CRITICAL').length
  const needsApproval = templates.filter(t => t.metadata?.requiresApprovalToRun).length
  const globalCount = templates.filter(t => t.metadata?.globallyAvailable).length

  // ── Type distribution ──
  const typeCounts: Record<string, number> = {}
  for (const t of templates) {
    const type = t.metadata?.workflowType ?? 'OTHER'
    typeCounts[type] = (typeCounts[type] ?? 0) + 1
  }
  const typeEntries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])

  // ── Teams ──
  const teams = [...new Set(templates.map(t => t.metadata?.teamName).filter(Boolean))]

  // ── Filtered list ──
  const filtered = templates.filter(t => {
    if (search && !t.name.toLowerCase().includes(search.toLowerCase()) && !(t.description ?? '').toLowerCase().includes(search.toLowerCase())) return false
    if (filterType !== 'ALL' && (t.metadata?.workflowType ?? 'OTHER') !== filterType) return false
    if (filterStatus !== 'ALL' && t.status !== filterStatus) return false
    return true
  })

  // ── Execution hint: runs per template ──
  const runsByTemplate = new Map<string, number>()
  for (const inst of instances) {
    if (inst.templateId) runsByTemplate.set(inst.templateId, (runsByTemplate.get(inst.templateId) ?? 0) + 1)
  }

  return (
    <div style={{ padding: '28px 28px 48px', maxWidth: 1160 }}>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,132,61,0.10)', border: '1px solid rgba(0,132,61,0.18)',
            }}>
              <Activity size={16} style={{ color: 'var(--color-primary)' }} />
            </div>
            <div>
              <h1 className="page-header" style={{ marginBottom: 0 }}>Workflow Designer</h1>
              <p style={{ fontSize: 11, color: 'var(--color-outline)', fontFamily: 'monospace', marginTop: 1 }}>
                Design catalog · {teams.length > 0 ? teams.join(', ') : 'All teams'}
              </p>
            </div>
          </div>

          {/* Execution engine note */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7, padding: '7px 14px',
            borderRadius: 10, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.18)',
          }}>
            <Info size={12} style={{ color: '#6366f1', flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 600 }}>Designer only — execution runs on your connected engine</span>
          </div>
        </div>
      </motion.div>

      {/* ── KPI strip ──────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, marginBottom: 24 }}>
        <KpiCard title="Total Designs"   value={total}        icon={GitBranch}    color="#00843D"  delay={0.04} />
        <KpiCard title="Published"       value={published}    icon={CheckCircle2} color="#00843D"  delay={0.07} sub={total > 0 ? `${Math.round(published/total*100)}%` : undefined} />
        <KpiCard title="In Draft"        value={draft}        icon={FileCode}     color="#94a3b8"  delay={0.10} />
        <KpiCard title="Critical"        value={critical}     icon={AlertTriangle}color="#ef4444"  delay={0.13} />
        <KpiCard title="Need Approval"   value={needsApproval}icon={Users}        color="#f59e0b"  delay={0.16} />
        <KpiCard title="Globally Avail." value={globalCount}  icon={Globe}        color="#6366f1"  delay={0.19} />
      </div>

      {/* ── Two-column: catalog + breakdown ───────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 20, alignItems: 'start' }}>

        {/* ── Workflow catalog ──────────────────────────────────────── */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, delay: 0.22 }}>
          <SectionHeader action="Open designer" onAction={() => navigate('/workflows?tab=templates')}>
            Workflow Catalog
          </SectionHeader>

          <div style={{ background: '#fff', border: '1px solid var(--color-outline-variant)', borderRadius: 14, boxShadow: '0 2px 8px rgba(12,23,39,0.04)', overflow: 'hidden' }}>

            {/* Search + filter bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--color-outline-variant)' }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface)' }}>
                <Search size={12} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search workflows…"
                  style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 12, outline: 'none', color: 'var(--color-on-surface)', fontFamily: 'inherit' }}
                />
              </div>

              {/* Type filter */}
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowFilterMenu(v => !v)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px',
                    borderRadius: 8, border: '1px solid var(--color-outline-variant)',
                    background: 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: 600,
                    color: 'var(--color-outline)',
                  }}
                >
                  <Filter size={11} />
                  {filterType === 'ALL' && filterStatus === 'ALL' ? 'Filter' : 'Filtered'}
                  <ChevronDown size={10} />
                </button>
                {showFilterMenu && (
                  <div
                    style={{
                      position: 'absolute', top: '110%', right: 0, zIndex: 50,
                      background: '#fff', border: '1px solid var(--color-outline-variant)',
                      borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                      padding: 12, minWidth: 200,
                    }}
                  >
                    <p style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-outline)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Type</p>
                    {['ALL', 'SDLC', 'BUSINESS', 'DATA_PIPELINE', 'INFRASTRUCTURE', 'COMPLIANCE', 'OTHER'].map(t => (
                      <button key={t} onClick={() => { setFilterType(t); setShowFilterMenu(false) }}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: filterType === t ? 700 : 400, background: filterType === t ? 'rgba(0,132,61,0.08)' : 'transparent', color: filterType === t ? 'var(--color-primary)' : 'var(--color-on-surface)' }}>
                        {t === 'ALL' ? 'All types' : TYPE_LABEL[t] ?? t}
                      </button>
                    ))}
                    <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '8px 0' }} />
                    <p style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-outline)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Status</p>
                    {['ALL', 'DRAFT', 'PUBLISHED', 'FINAL', 'ARCHIVED'].map(s => (
                      <button key={s} onClick={() => { setFilterStatus(s); setShowFilterMenu(false) }}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: filterStatus === s ? 700 : 400, background: filterStatus === s ? 'rgba(0,132,61,0.08)' : 'transparent', color: filterStatus === s ? 'var(--color-primary)' : 'var(--color-on-surface)' }}>
                        {s === 'ALL' ? 'All statuses' : s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Column headers */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 100px 82px 74px 130px 68px 32px',
              alignItems: 'center', gap: 12, padding: '7px 16px',
              background: 'var(--color-surface)',
            }}>
              {['Name', 'Type', 'Status', 'Priority', 'Owner / Team', 'Updated', ''].map(h => (
                <span key={h} style={{ fontSize: 9, fontWeight: 700, color: 'var(--color-outline)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{h}</span>
              ))}
            </div>

            {/* Rows */}
            {isLoading ? (
              <div style={{ padding: '32px 20px', textAlign: 'center' }}>
                <Clock size={22} style={{ color: 'var(--color-outline-variant)', margin: '0 auto 8px' }} />
                <p style={{ fontSize: 12, color: 'var(--color-outline)' }}>Loading…</p>
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: '36px 20px', textAlign: 'center' }}>
                <GitBranch size={26} style={{ color: 'var(--color-outline-variant)', margin: '0 auto 10px' }} />
                <p style={{ fontSize: 13, color: 'var(--color-outline)' }}>
                  {search || filterType !== 'ALL' || filterStatus !== 'ALL' ? 'No workflows match your filters' : 'No workflow designs yet'}
                </p>
                {!search && filterType === 'ALL' && filterStatus === 'ALL' && (
                  <button onClick={() => navigate('/workflows')} style={{ marginTop: 10, fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer' }}>
                    Create your first workflow →
                  </button>
                )}
              </div>
            ) : (
              <div>
                {filtered.map(tmpl => (
                  <WorkflowRow
                    key={tmpl.id}
                    tmpl={tmpl}
                    onOpen={() => navigate('/workflows')}
                  />
                ))}
              </div>
            )}

            {filtered.length > 0 && (
              <div style={{ padding: '8px 16px', borderTop: '1px solid var(--color-outline-variant)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>
                  {filtered.length} of {templates.length} workflow{templates.length !== 1 ? 's' : ''}
                </span>
                {(filterType !== 'ALL' || filterStatus !== 'ALL' || search) && (
                  <button onClick={() => { setSearch(''); setFilterType('ALL'); setFilterStatus('ALL') }}
                    style={{ fontSize: 10, color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                    Clear filters
                  </button>
                )}
              </div>
            )}
          </div>
        </motion.div>

        {/* ── Right sidebar ──────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* Type breakdown */}
          <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.26, delay: 0.28 }}>
            <SectionHeader>By Type</SectionHeader>
            <div style={{ background: '#fff', border: '1px solid var(--color-outline-variant)', borderRadius: 14, padding: '16px', boxShadow: '0 2px 8px rgba(12,23,39,0.04)' }}>
              {typeEntries.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--color-outline)', textAlign: 'center', padding: '12px 0' }}>No data yet</p>
              ) : (
                typeEntries.map(([type, count]) => (
                  <TypeBar
                    key={type}
                    label={TYPE_LABEL[type] ?? type}
                    count={count}
                    total={total}
                    color={TYPE_COLOR[type] ?? '#64748b'}
                  />
                ))
              )}
            </div>
          </motion.div>

          {/* Status breakdown */}
          <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.26, delay: 0.32 }}>
            <SectionHeader>By Status</SectionHeader>
            <div style={{ background: '#fff', border: '1px solid var(--color-outline-variant)', borderRadius: 14, padding: '16px', boxShadow: '0 2px 8px rgba(12,23,39,0.04)' }}>
              {(['PUBLISHED', 'DRAFT', 'FINAL', 'ARCHIVED'] as const).map(status => {
                const count = templates.filter(t => t.status === status).length
                if (count === 0 && status === 'ARCHIVED') return null
                return (
                  <div key={status} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[status] ?? '#94a3b8', display: 'inline-block', flexShrink: 0 }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-on-surface)' }}>{status.charAt(0) + status.slice(1).toLowerCase()}</span>
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: STATUS_COLOR[status] ?? '#94a3b8' }}>{count}</span>
                  </div>
                )
              })}
            </div>
          </motion.div>

          {/* Teams */}
          {teams.length > 0 && (
            <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.26, delay: 0.36 }}>
              <SectionHeader>Teams</SectionHeader>
              <div style={{ background: '#fff', border: '1px solid var(--color-outline-variant)', borderRadius: 14, padding: '16px', boxShadow: '0 2px 8px rgba(12,23,39,0.04)' }}>
                {teams.map(team => {
                  const teamCount = templates.filter(t => t.metadata?.teamName === team).length
                  return (
                    <div key={team} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <Users size={11} style={{ color: 'var(--color-outline)' }} />
                        <span style={{ fontSize: 12, color: 'var(--color-on-surface)', fontWeight: 600 }}>{team}</span>
                      </div>
                      <span style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--color-outline)', fontWeight: 700 }}>{teamCount}</span>
                    </div>
                  )
                })}
              </div>
            </motion.div>
          )}

          {/* Tags cloud */}
          {templates.some(t => (t.metadata?.tags ?? []).length > 0) && (
            <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.26, delay: 0.40 }}>
              <SectionHeader>Tags</SectionHeader>
              <div style={{ background: '#fff', border: '1px solid var(--color-outline-variant)', borderRadius: 14, padding: '14px 16px', boxShadow: '0 2px 8px rgba(12,23,39,0.04)' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(() => {
                    const tagCounts: Record<string, number> = {}
                    for (const t of templates) {
                      for (const tag of t.metadata?.tags ?? []) {
                        if (tag.key) tagCounts[tag.key] = (tagCounts[tag.key] ?? 0) + 1
                      }
                    }
                    return Object.entries(tagCounts).slice(0, 16).map(([key, count]) => (
                      <span key={key} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                        background: 'rgba(0,132,61,0.07)', color: 'var(--color-primary)',
                        border: '1px solid rgba(0,132,61,0.15)',
                      }}>
                        <Tag size={9} /> {key}
                        {count > 1 && <span style={{ opacity: 0.6 }}>·{count}</span>}
                      </span>
                    ))
                  })()}
                </div>
              </div>
            </motion.div>
          )}

          {/* Execution note */}
          <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.26, delay: 0.44 }}>
            <div style={{
              padding: '14px 16px', borderRadius: 14,
              background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.18)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                <Layers size={13} style={{ color: '#6366f1' }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: '#6366f1' }}>Execution Summary</span>
              </div>
              <p style={{ fontSize: 11, color: '#64748b', lineHeight: 1.6, marginBottom: 8 }}>
                This is a workflow <strong>designer</strong>. Execution data comes from your connected engine.
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: '#64748b' }}>Instances recorded</span>
                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', color: '#6366f1' }}>{instances.length}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, color: '#64748b' }}>Workflows with runs</span>
                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', color: '#6366f1' }}>{runsByTemplate.size}</span>
              </div>
            </div>
          </motion.div>

        </div>
      </div>
    </div>
  )
}
