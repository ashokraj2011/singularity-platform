import { useState, useMemo, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  Inbox, Users, User, Layers, Workflow, GitMerge, Package, Network,
  ArrowRight, Clock, Search, Filter, Plus,
} from 'lucide-react'
import { api } from '../../lib/api'

// ── Types (mirror of the API response) ───────────────────────────────────────

type InboxKind = 'task' | 'approval' | 'consumable' | 'workitem'

type InboxItem = {
  kind:               InboxKind
  id:                 string
  title:              string
  workflowInstanceId: string | null
  workflowName?:      string | null
  nodeId:             string | null
  nodeLabel?:         string | null
  status:             string
  assignmentMode:     string | null
  dueAt:              string | null
  priority?:          number | null
  workCode?:          string | null
  originType?:        string | null
  urgency?:           string | null
  createdAt:          string
  updatedAt:          string
  claimable:          boolean
  targetId?:          string | null
  targetCapabilityId?: string | null
}

type LookupCapability = {
  id: string
  name: string
  capability_type?: string
}

type CreateWorkItemForm = {
  title: string
  description: string
  targetCapabilityId: string
  urgency: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'
  requiredBy: string
  maxTotalTokens: string
  maxEstimatedCost: string
}

type InboxResponse = {
  counts:    { mine: number; available: number; done: number }
  mine:      InboxItem[]
  available: InboxItem[]
  done:      InboxItem[]
}

const KIND_META: Record<InboxKind, { label: string; color: string; Icon: React.ElementType }> = {
  task:       { label: 'Task',       color: '#22c55e', Icon: User },
  approval:   { label: 'Approval',   color: '#f59e0b', Icon: GitMerge },
  consumable: { label: 'Deliverable',color: '#10b981', Icon: Package },
  workitem:   { label: 'WorkItem',   color: '#8b5cf6', Icon: Network },
}

const MODE_META: Record<string, { label: string; color: string; Icon: React.ElementType }> = {
  DIRECT_USER: { label: 'Direct',  color: '#22c55e', Icon: User },
  TEAM_QUEUE:  { label: 'Team',    color: '#0ea5e9', Icon: Users },
  ROLE_BASED:  { label: 'Role',    color: '#a855f7', Icon: Layers },
  SKILL_BASED: { label: 'Skill',   color: '#f97316', Icon: Layers },
  AGENT:       { label: 'Agent',   color: '#38bdf8', Icon: Workflow },
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function InboxPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'mine' | 'available' | 'done'>('mine')
  const [kindFilter, setKindFilter] = useState<'all' | InboxKind>('all')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState<CreateWorkItemForm>({
    title: '',
    description: '',
    targetCapabilityId: '',
    urgency: 'NORMAL',
    requiredBy: '',
    maxTotalTokens: '',
    maxEstimatedCost: '',
  })

  const { data, isLoading, refetch } = useQuery<InboxResponse>({
    queryKey: ['runtime-inbox'],
    queryFn:  () => api.get('/runtime/inbox').then(r => r.data),
    refetchInterval: 15_000,
  })
  const capabilities = useQuery<LookupCapability[]>({
    queryKey: ['runtime-workitem-capabilities'],
    queryFn: () => api.get('/lookup/capabilities', { params: { size: 200 } }).then(r => unwrapItems<LookupCapability>(r.data)),
    staleTime: 60_000,
  })
  const createMut = useMutation({
    mutationFn: async () => {
      const title = createForm.title.trim()
      if (!title || !createForm.targetCapabilityId) throw new Error('Title and target capability are required')
      const budget: Record<string, unknown> = {}
      const maxTotalTokens = Number(createForm.maxTotalTokens)
      const maxEstimatedCost = Number(createForm.maxEstimatedCost)
      if (Number.isFinite(maxTotalTokens) && maxTotalTokens > 0) budget.maxTotalTokens = maxTotalTokens
      if (Number.isFinite(maxEstimatedCost) && maxEstimatedCost > 0) budget.maxEstimatedCost = maxEstimatedCost
      return api.post('/work-items', {
        title,
        description: createForm.description.trim() || undefined,
        originType: 'CAPABILITY_LOCAL',
        details: {
          title,
          description: createForm.description.trim() || null,
          source: 'runtime-worklist',
        },
        budget,
        urgency: createForm.urgency,
        requiredBy: createForm.requiredBy ? new Date(createForm.requiredBy).toISOString() : undefined,
        dueAt: createForm.requiredBy ? new Date(createForm.requiredBy).toISOString() : undefined,
        targets: [{ targetCapabilityId: createForm.targetCapabilityId }],
      }).then(r => r.data)
    },
    onSuccess: () => {
      setShowCreate(false)
      setCreateForm({ title: '', description: '', targetCapabilityId: '', urgency: 'NORMAL', requiredBy: '', maxTotalTokens: '', maxEstimatedCost: '' })
      refetch()
    },
  })

  const list = useMemo(() => {
    const raw = (data?.[tab] ?? []) as InboxItem[]
    return raw
      .filter(i => kindFilter === 'all' || i.kind === kindFilter)
      .filter(i => !search.trim() ||
        i.title.toLowerCase().includes(search.toLowerCase()) ||
        i.workflowName?.toLowerCase().includes(search.toLowerCase()) ||
        i.nodeLabel?.toLowerCase().includes(search.toLowerCase()))
  }, [data, tab, kindFilter, search])

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'rgba(0,132,61,0.10)', border: '1px solid rgba(0,132,61,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00843D',
        }}>
          <Inbox size={18} />
        </div>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-on-surface)', margin: 0, letterSpacing: '-0.01em' }}>
            Inbox
          </h1>
          <p style={{ fontSize: 12, color: 'var(--color-outline)', margin: 0 }}>
            Tasks, approvals, and deliverables routed to you across all workflows.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(v => !v)}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', gap: 7,
            padding: '9px 13px', borderRadius: 9,
            border: '1px solid rgba(0,132,61,0.25)',
            background: 'rgba(0,132,61,0.10)',
            color: '#006227', fontSize: 12, fontWeight: 800,
            cursor: 'pointer',
          }}
        >
          <Plus size={14} /> New WorkItem
        </button>
      </div>

      {/* Tab strip */}
      <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 10, background: 'var(--color-surface-container)', border: '1px solid var(--color-outline-variant)', marginBottom: 12 }}>
        <Tab label="Mine"      count={data?.counts.mine     ?? 0} active={tab === 'mine'}      onClick={() => setTab('mine')} />
        <Tab label="Available" count={data?.counts.available ?? 0} active={tab === 'available'} onClick={() => setTab('available')} />
        <Tab label="Done (30d)" count={data?.counts.done    ?? 0} active={tab === 'done'}      onClick={() => setTab('done')} />
      </div>

      {showCreate && (
        <div style={{ padding: 14, borderRadius: 12, background: '#fff', border: '1px solid var(--color-outline-variant)', marginBottom: 14 }}>
          <h2 style={{ margin: '0 0 10px', fontSize: 16, color: 'var(--color-on-surface)' }}>Create capability WorkItem</h2>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <input value={createForm.title} onChange={e => setCreateForm(f => ({ ...f, title: e.target.value }))} placeholder="WorkItem title" style={inputStyle} />
            <select value={createForm.targetCapabilityId} onChange={e => setCreateForm(f => ({ ...f, targetCapabilityId: e.target.value }))} style={inputStyle}>
              <option value="">Target capability</option>
              {(capabilities.data ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={createForm.urgency} onChange={e => setCreateForm(f => ({ ...f, urgency: e.target.value as CreateWorkItemForm['urgency'] }))} style={inputStyle}>
              <option value="LOW">Low urgency</option>
              <option value="NORMAL">Normal urgency</option>
              <option value="HIGH">High urgency</option>
              <option value="CRITICAL">Critical urgency</option>
            </select>
            <input value={createForm.requiredBy} onChange={e => setCreateForm(f => ({ ...f, requiredBy: e.target.value }))} type="datetime-local" style={inputStyle} />
            <input value={createForm.maxTotalTokens} onChange={e => setCreateForm(f => ({ ...f, maxTotalTokens: e.target.value }))} placeholder="Token budget optional" style={inputStyle} />
            <input value={createForm.maxEstimatedCost} onChange={e => setCreateForm(f => ({ ...f, maxEstimatedCost: e.target.value }))} placeholder="Cost budget optional" style={inputStyle} />
          </div>
          <textarea value={createForm.description} onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))} placeholder="Immutable request details, acceptance notes, constraints..." rows={4} style={{ ...inputStyle, marginTop: 10, resize: 'vertical' }} />
          {createMut.error && <p style={{ margin: '8px 0 0', fontSize: 12, color: '#dc2626' }}>{(createMut.error as Error).message}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <button onClick={() => setShowCreate(false)} style={secondaryButtonStyle}>Cancel</button>
            <button onClick={() => createMut.mutate()} disabled={createMut.isPending} style={primaryButtonStyle}>
              {createMut.isPending ? 'Creating...' : 'Create WorkItem'}
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={12} style={{ position: 'absolute', top: '50%', left: 10, transform: 'translateY(-50%)', color: 'var(--color-outline)' }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search title, workflow, or node…"
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
          value={kindFilter}
          onChange={e => setKindFilter(e.target.value as typeof kindFilter)}
          style={{
            padding: '7px 10px', borderRadius: 8,
            border: '1px solid var(--color-outline-variant)', background: '#fff',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', outline: 'none',
          }}
        >
          <option value="all">All kinds</option>
          <option value="task">Tasks</option>
          <option value="approval">Approvals</option>
          <option value="consumable">Deliverables</option>
          <option value="workitem">WorkItems</option>
        </select>
        <button
          onClick={() => refetch()}
          style={{
            padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
            border: '1px solid var(--color-outline-variant)', background: 'transparent',
            cursor: 'pointer', color: 'var(--color-outline)',
          }}
        >
          Refresh
        </button>
      </div>

      {/* List */}
      {isLoading ? (
        <p style={{ fontSize: 13, color: 'var(--color-outline)' }}>Loading…</p>
      ) : list.length === 0 ? (
        <EmptyState tab={tab} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map(item => (
            <Row
              key={`${item.kind}:${item.id}:${item.targetId ?? ''}`}
              item={item}
              onOpen={() => navigate(`/runtime/work/${item.kind}/${item.id}${item.targetId ? `?targetId=${item.targetId}` : ''}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 11px',
  borderRadius: 9,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  fontSize: 13,
  outline: 'none',
}

const primaryButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  padding: '8px 12px',
  borderRadius: 9,
  border: 'none',
  background: '#00843D',
  color: '#fff',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
}

const secondaryButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  padding: '8px 12px',
  borderRadius: 9,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: 'var(--color-on-surface)',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
}

function unwrapItems<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.content)) return obj.content as T[]
    if (Array.isArray(obj.items)) return obj.items as T[]
    if (Array.isArray(obj.data)) return obj.data as T[]
  }
  return []
}

// ── Sub-components ──────────────────────────────────────────────────────────

function Tab({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: '7px 12px', borderRadius: 8, border: 'none',
        background: active ? '#fff' : 'transparent',
        boxShadow: active ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
        fontSize: 12, fontWeight: 700, cursor: 'pointer',
        color: active ? 'var(--color-on-surface)' : 'var(--color-outline)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
      }}
    >
      {label}
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: 20, padding: '0 6px', height: 16, borderRadius: 8,
        fontSize: 10, fontWeight: 800,
        background: active ? 'rgba(0,132,61,0.10)' : 'var(--color-outline-variant)',
        color:      active ? '#00843D' : 'var(--color-outline)',
      }}>
        {count}
      </span>
    </button>
  )
}

function Row({ item, onOpen }: { item: InboxItem; onOpen: () => void }) {
  const km = KIND_META[item.kind]
  const mm = item.assignmentMode ? MODE_META[item.assignmentMode] : null
  const dueIn = item.dueAt ? formatDueIn(item.dueAt) : null

  return (
    <motion.button
      onClick={onOpen}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '12px 16px',
        borderRadius: 10, border: '1px solid var(--color-outline-variant)',
        background: '#fff', cursor: 'pointer', textAlign: 'left',
      }}
    >
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        background: `${km.color}15`, border: `1px solid ${km.color}30`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: km.color, flexShrink: 0,
      }}>
        <km.Icon size={14} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.title}
          </span>
          <span style={{
            fontSize: 9, fontWeight: 700, color: km.color,
            background: `${km.color}10`, padding: '2px 6px', borderRadius: 4,
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>
            {km.label}
          </span>
          {mm && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              fontSize: 9, fontWeight: 700, color: mm.color,
              background: `${mm.color}10`, padding: '2px 6px', borderRadius: 4,
              letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>
              <mm.Icon size={9} /> {mm.label}
            </span>
          )}
          {item.claimable && (
            <span style={{
              fontSize: 9, fontWeight: 700, color: '#0ea5e9',
              background: 'rgba(14,165,233,0.10)', padding: '2px 6px', borderRadius: 4,
              letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>
              Claimable
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
          {item.workflowName && (
            <span style={{ fontSize: 11, color: 'var(--color-outline)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Workflow size={10} /> {item.workflowName}
            </span>
          )}
          {item.nodeLabel && (
            <span style={{ fontSize: 11, color: 'var(--color-outline)' }}>
              · {item.nodeLabel}
            </span>
          )}
          {dueIn && (
            <span style={{ fontSize: 11, color: dueIn.color, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Clock size={10} /> {dueIn.text}
            </span>
          )}
          <span style={{ fontSize: 10, color: 'var(--color-outline)', fontFamily: 'monospace', marginLeft: 'auto' }}>
            {item.status}
          </span>
        </div>
      </div>

      <ArrowRight size={14} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />
    </motion.button>
  )
}

function EmptyState({ tab }: { tab: 'mine' | 'available' | 'done' }) {
  const messages = {
    mine:      { title: 'Nothing assigned to you',   sub: 'When work lands directly on your plate, it shows here.' },
    available: { title: 'No claimable work',         sub: 'Items routed to your team / role / skills will appear here.' },
    done:      { title: 'No completed work yet',     sub: 'Items you finish in the next 30 days will show up here.' },
  }
  const m = messages[tab]
  return (
    <div style={{
      padding: '48px 16px', textAlign: 'center',
      borderRadius: 12, border: '1px dashed var(--color-outline-variant)', background: '#fafafa',
    }}>
      <Inbox size={32} style={{ color: 'var(--color-outline)', opacity: 0.5, marginBottom: 8 }} />
      <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-on-surface)', marginBottom: 4 }}>{m.title}</p>
      <p style={{ fontSize: 12, color: 'var(--color-outline)' }}>{m.sub}</p>
    </div>
  )
}

function formatDueIn(iso: string): { text: string; color: string } {
  const ms = new Date(iso).getTime() - Date.now()
  const hrs = Math.round(ms / (60 * 60 * 1000))
  if (hrs < 0)   return { text: `Overdue ${Math.abs(hrs)}h`, color: '#ef4444' }
  if (hrs === 0) return { text: 'Due now',                   color: '#f59e0b' }
  if (hrs < 24)  return { text: `Due in ${hrs}h`,            color: '#f59e0b' }
  const days = Math.round(hrs / 24)
  return { text: `Due in ${days}d`, color: 'var(--color-outline)' }
}
