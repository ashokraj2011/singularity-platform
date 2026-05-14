import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import {
  GitBranch, ExternalLink, Search, Filter,
  ChevronDown, AlertTriangle, CheckCircle2, Clock, Users,
  FileCode, Layers, Tag, Globe, PlayCircle, LayoutDashboard,
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

const SURFACE = 'var(--color-surface-bright, #ffffff)'
const SURFACE_LOW = 'var(--color-surface-low, #f8fbfb)'
const BORDER = 'var(--color-outline-variant, #cfd8de)'
const TEXT = 'var(--color-on-surface, #162033)'
const MUTED = 'var(--color-outline, #6a7486)'
const PRIMARY = 'var(--color-primary, #00843D)'
const CARD_SHADOW = '0 1px 2px rgba(12,23,39,0.05)'
const CARD_RADIUS = 8

const panelStyle: React.CSSProperties = {
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  borderRadius: CARD_RADIUS,
  boxShadow: CARD_SHADOW,
}

const buttonBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  height: 34,
  padding: '0 13px',
  borderRadius: CARD_RADIUS,
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'var(--font-sans)',
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 'fit-content', minHeight: 20, fontSize: 9, fontWeight: 800,
      fontFamily: 'var(--font-sans)', textTransform: 'uppercase', letterSpacing: '0.08em',
      padding: '2px 8px', borderRadius: 999,
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
        ...panelStyle,
        padding: '15px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{
          width: 34, height: 34, borderRadius: CARD_RADIUS, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${color}12`, border: `1px solid ${color}25`,
        }}>
          <Icon size={15} style={{ color }} />
        </div>
        {sub && <span style={{ fontSize: 10, color: MUTED, fontWeight: 700 }}>{sub}</span>}
      </div>
      <p style={{ fontSize: 24, fontWeight: 800, color: TEXT, lineHeight: 1, marginBottom: 5, fontFamily: 'var(--font-sans)' }}>
        {value}
      </p>
      <p style={{ fontSize: 10, fontWeight: 800, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {title}
      </p>
    </motion.div>
  )
}

function SectionHeader({ children, action, onAction }: { children: React.ReactNode; action?: string; onAction?: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <div style={{ width: 3, height: 13, borderRadius: 2, background: PRIMARY, opacity: 0.8 }} />
        <h2 style={{ fontSize: 11, fontWeight: 800, color: TEXT, textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--font-sans)' }}>
          {children}
        </h2>
      </div>
      {action && onAction && (
        <button onClick={onAction} style={{ ...buttonBase, height: 30, border: `1px solid ${BORDER}`, color: PRIMARY, background: SURFACE }}>
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
        <span style={{ fontSize: 11, fontWeight: 700, color: TEXT }}>{label}</span>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: MUTED }}>{count} · {pct}%</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: BORDER, overflow: 'hidden' }}>
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
        padding: '11px 16px', cursor: 'pointer',
        borderTop: `1px solid ${BORDER}`,
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = SURFACE_LOW)}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {/* Name */}
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tmpl.name}
        </p>
        {tmpl.description && (
          <p style={{ fontSize: 11, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
            {tmpl.description}
          </p>
        )}
      </div>
      {/* Type */}
      <Pill label={TYPE_LABEL[type] ?? type} color={TYPE_COLOR[type] ?? '#64748b'} />
      {/* Status */}
      <Pill label={tmpl.status} color={statusColor} />
      {/* Criticality */}
      {crit ? <Pill label={crit} color={CRIT_COLOR[crit] ?? '#64748b'} /> : <span style={{ fontSize: 10, color: MUTED }}>—</span>}
      {/* Owner / Team */}
      <span style={{ fontSize: 11, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {owner}
      </span>
      {/* Updated */}
      <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: MUTED }}>{updated}</span>
      {/* Open */}
      <ExternalLink size={12} style={{ color: MUTED, flexShrink: 0 }} />
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
    <div style={{ padding: '24px 28px 48px', maxWidth: 1280, margin: '0 auto' }}>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 38, height: 38, borderRadius: CARD_RADIUS, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,132,61,0.10)', border: '1px solid rgba(0,132,61,0.18)',
            }}>
              <LayoutDashboard size={17} style={{ color: PRIMARY }} />
            </div>
            <div>
              <h1 className="page-header" style={{ marginBottom: 0 }}>Workflow Manager</h1>
              <p style={{ fontSize: 12, color: MUTED, marginTop: 3, maxWidth: 620 }}>
                Design workflows, run them, approve pauses, and inspect execution evidence.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={() => navigate('/run')}
              style={{ ...buttonBase, color: '#ffffff', background: PRIMARY, border: `1px solid ${PRIMARY}` }}
            >
              <PlayCircle size={14} /> Start Run
            </button>
            <button
              onClick={() => navigate('/workflows?tab=templates')}
              style={{ ...buttonBase, color: TEXT, background: SURFACE, border: `1px solid ${BORDER}` }}
            >
              <GitBranch size={14} /> Manage Designs
            </button>
          </div>
        </div>
      </motion.div>

      {/* ── KPI strip ──────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
        <KpiCard title="Total Designs"   value={total}        icon={GitBranch}    color="#00843D"  delay={0.04} />
        <KpiCard title="Published"       value={published}    icon={CheckCircle2} color="#00843D"  delay={0.07} sub={total > 0 ? `${Math.round(published/total*100)}%` : undefined} />
        <KpiCard title="In Draft"        value={draft}        icon={FileCode}     color="#94a3b8"  delay={0.10} />
        <KpiCard title="Critical"        value={critical}     icon={AlertTriangle}color="#ef4444"  delay={0.13} />
        <KpiCard title="Need Approval"   value={needsApproval}icon={Users}        color="#f59e0b"  delay={0.16} />
        <KpiCard title="Globally Avail." value={globalCount}  icon={Globe}        color="#6366f1"  delay={0.19} />
      </div>

      {/* ── Two-column: catalog + breakdown ───────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 20, alignItems: 'start' }}>

        {/* ── Workflow catalog ──────────────────────────────────────── */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, delay: 0.22 }}>
          <SectionHeader action="Open designer" onAction={() => navigate('/workflows?tab=templates')}>
            Workflow Catalog
          </SectionHeader>

          <div style={{ ...panelStyle, overflow: 'hidden' }}>

            {/* Search + filter bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: `1px solid ${BORDER}` }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: CARD_RADIUS, border: `1px solid ${BORDER}`, background: SURFACE_LOW }}>
                <Search size={12} style={{ color: MUTED, flexShrink: 0 }} />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search workflows…"
                  style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 12, outline: 'none', color: TEXT, fontFamily: 'inherit' }}
                />
              </div>

              {/* Type filter */}
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowFilterMenu(v => !v)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px',
                    borderRadius: CARD_RADIUS, border: `1px solid ${BORDER}`,
                    background: 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: 600,
                    color: MUTED,
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
                      ...panelStyle,
                      padding: 12, minWidth: 200,
                    }}
                  >
                    <p style={{ fontSize: 10, fontWeight: 800, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Type</p>
                    {['ALL', 'SDLC', 'BUSINESS', 'DATA_PIPELINE', 'INFRASTRUCTURE', 'COMPLIANCE', 'OTHER'].map(t => (
                      <button key={t} onClick={() => { setFilterType(t); setShowFilterMenu(false) }}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: filterType === t ? 700 : 500, background: filterType === t ? 'rgba(0,132,61,0.08)' : 'transparent', color: filterType === t ? PRIMARY : TEXT }}>
                        {t === 'ALL' ? 'All types' : TYPE_LABEL[t] ?? t}
                      </button>
                    ))}
                    <div style={{ height: 1, background: BORDER, margin: '8px 0' }} />
                    <p style={{ fontSize: 10, fontWeight: 800, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Status</p>
                    {['ALL', 'DRAFT', 'PUBLISHED', 'FINAL', 'ARCHIVED'].map(s => (
                      <button key={s} onClick={() => { setFilterStatus(s); setShowFilterMenu(false) }}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: filterStatus === s ? 700 : 500, background: filterStatus === s ? 'rgba(0,132,61,0.08)' : 'transparent', color: filterStatus === s ? PRIMARY : TEXT }}>
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
              background: SURFACE_LOW,
            }}>
              {['Name', 'Type', 'Status', 'Priority', 'Owner / Team', 'Updated', ''].map(h => (
                <span key={h} style={{ fontSize: 9, fontWeight: 800, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</span>
              ))}
            </div>

            {/* Rows */}
            {isLoading ? (
              <div style={{ padding: '32px 20px', textAlign: 'center' }}>
                <Clock size={22} style={{ color: BORDER, margin: '0 auto 8px' }} />
                <p style={{ fontSize: 12, color: MUTED }}>Loading…</p>
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: '36px 20px', textAlign: 'center' }}>
                <GitBranch size={26} style={{ color: BORDER, margin: '0 auto 10px' }} />
                <p style={{ fontSize: 13, color: MUTED }}>
                  {search || filterType !== 'ALL' || filterStatus !== 'ALL' ? 'No workflows match your filters' : 'No workflow designs yet'}
                </p>
                {!search && filterType === 'ALL' && filterStatus === 'ALL' && (
                  <button onClick={() => navigate('/workflows')} style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: PRIMARY, background: 'none', border: 'none', cursor: 'pointer' }}>
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
              <div style={{ padding: '9px 16px', borderTop: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: MUTED }}>
                  {filtered.length} of {templates.length} workflow{templates.length !== 1 ? 's' : ''}
                </span>
                {(filterType !== 'ALL' || filterStatus !== 'ALL' || search) && (
                  <button onClick={() => { setSearch(''); setFilterType('ALL'); setFilterStatus('ALL') }}
                    style={{ fontSize: 10, color: PRIMARY, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}>
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
            <div style={{ ...panelStyle, padding: '16px' }}>
              {typeEntries.length === 0 ? (
                <p style={{ fontSize: 12, color: MUTED, textAlign: 'center', padding: '12px 0' }}>No data yet</p>
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
            <div style={{ ...panelStyle, padding: '16px' }}>
              {(['PUBLISHED', 'DRAFT', 'FINAL', 'ARCHIVED'] as const).map(status => {
                const count = templates.filter(t => t.status === status).length
                if (count === 0 && status === 'ARCHIVED') return null
                return (
                  <div key={status} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[status] ?? '#94a3b8', display: 'inline-block', flexShrink: 0 }} />
                      <span style={{ fontSize: 12, fontWeight: 700, color: TEXT }}>{status.charAt(0) + status.slice(1).toLowerCase()}</span>
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'var(--font-mono)', color: STATUS_COLOR[status] ?? '#94a3b8' }}>{count}</span>
                  </div>
                )
              })}
            </div>
          </motion.div>

          {/* Teams */}
          {teams.length > 0 && (
            <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.26, delay: 0.36 }}>
              <SectionHeader>Teams</SectionHeader>
              <div style={{ ...panelStyle, padding: '16px' }}>
                {teams.map(team => {
                  const teamCount = templates.filter(t => t.metadata?.teamName === team).length
                  return (
                    <div key={team} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <Users size={11} style={{ color: MUTED }} />
                        <span style={{ fontSize: 12, color: TEXT, fontWeight: 700 }}>{team}</span>
                      </div>
                      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: MUTED, fontWeight: 800 }}>{teamCount}</span>
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
              <div style={{ ...panelStyle, padding: '14px 16px' }}>
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
              ...panelStyle,
              padding: '14px 16px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                <Layers size={13} style={{ color: PRIMARY }} />
                <span style={{ fontSize: 11, fontWeight: 800, color: PRIMARY }}>Execution Summary</span>
              </div>
              <p style={{ fontSize: 11, color: MUTED, lineHeight: 1.6, marginBottom: 8 }}>
                Recent run data is shown alongside designs so authors can move from design to execution evidence quickly.
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: MUTED }}>Instances recorded</span>
                <span style={{ fontSize: 11, fontWeight: 800, fontFamily: 'var(--font-mono)', color: PRIMARY }}>{instances.length}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, color: MUTED }}>Workflows with runs</span>
                <span style={{ fontSize: 11, fontWeight: 800, fontFamily: 'var(--font-mono)', color: PRIMARY }}>{runsByTemplate.size}</span>
              </div>
            </div>
          </motion.div>

        </div>
      </div>
    </div>
  )
}
