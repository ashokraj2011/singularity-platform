import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  Inbox, Users, User, Layers, Workflow, GitMerge, Package,
  ArrowRight, Clock, Search, Filter,
} from 'lucide-react'
import { api } from '../../lib/api'

// ── Types (mirror of the API response) ───────────────────────────────────────

type InboxKind = 'task' | 'approval' | 'consumable'

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
  createdAt:          string
  updatedAt:          string
  claimable:          boolean
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

  const { data, isLoading, refetch } = useQuery<InboxResponse>({
    queryKey: ['runtime-inbox'],
    queryFn:  () => api.get('/runtime/inbox').then(r => r.data),
    refetchInterval: 15_000,
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
      </div>

      {/* Tab strip */}
      <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 10, background: 'var(--color-surface-container)', border: '1px solid var(--color-outline-variant)', marginBottom: 12 }}>
        <Tab label="Mine"      count={data?.counts.mine     ?? 0} active={tab === 'mine'}      onClick={() => setTab('mine')} />
        <Tab label="Available" count={data?.counts.available ?? 0} active={tab === 'available'} onClick={() => setTab('available')} />
        <Tab label="Done (30d)" count={data?.counts.done    ?? 0} active={tab === 'done'}      onClick={() => setTab('done')} />
      </div>

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
            <Row key={`${item.kind}:${item.id}`} item={item} onOpen={() => navigate(`/runtime/work/${item.kind}/${item.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
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
