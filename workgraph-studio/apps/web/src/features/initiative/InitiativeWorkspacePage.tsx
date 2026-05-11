import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import { api } from '../../lib/api'
import { ArrowLeft, Briefcase, LayoutDashboard, GitBranch, CheckSquare, ThumbsUp, Package, Bot, Wrench, Receipt, Plus, X, Loader2, ExternalLink, Play } from 'lucide-react'

const TABS = [
  { key: 'overview',    label: 'Overview',    icon: LayoutDashboard },
  { key: 'workflow',    label: 'Workflow',     icon: GitBranch },
  { key: 'tasks',       label: 'Tasks',        icon: CheckSquare },
  { key: 'approvals',   label: 'Approvals',    icon: ThumbsUp },
  { key: 'consumables', label: 'Consumables',  icon: Package },
  { key: 'agents',      label: 'Agents',       icon: Bot },
  { key: 'tools',       label: 'Tools',        icon: Wrench },
  { key: 'receipts',    label: 'Receipts',     icon: Receipt },
] as const

type TabKey = typeof TABS[number]['key']

const statusColor: Record<string, string> = {
  DRAFT: '#64748b',
  ACTIVE: '#22d3ee',
  PAUSED: '#f59e0b',
  COMPLETED: '#10b981',
  CANCELLED: '#ef4444',
  FAILED: '#dc2626',
}

export function InitiativeWorkspacePage() {
  const { id, tab } = useParams()
  const navigate = useNavigate()
  const activeTab = (tab ?? 'overview') as TabKey

  const { data: initiative, isLoading } = useQuery({
    queryKey: ['initiatives', id],
    queryFn: () => api.get(`/initiatives/${id}`).then(r => r.data),
    enabled: !!id,
  })

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="skeleton h-8 w-64 rounded-xl" />
        <div className="skeleton h-10 w-full rounded-xl" />
        <div className="skeleton h-64 w-full rounded-xl" />
      </div>
    )
  }

  const statusClr = statusColor[initiative?.status ?? ''] ?? '#64748b'

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="px-6 pt-6 pb-4 shrink-0"
      >
        <div className="flex items-start gap-3">
          <button
            onClick={() => navigate('/initiatives')}
            className="mt-0.5 w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-start gap-3 min-w-0">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.2)' }}
            >
              <Briefcase className="w-4 h-4" style={{ color: '#22d3ee' }} />
            </div>
            <div className="min-w-0">
              <h1 className="page-header truncate">{initiative?.title ?? 'Initiative'}</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span
                  className="text-xs font-mono px-2 py-0.5 rounded-md"
                  style={{ background: `${statusClr}12`, color: statusClr, border: `1px solid ${statusClr}20` }}
                >
                  {initiative?.status}
                </span>
                {initiative?.description && (
                  <span className="text-xs text-slate-500 truncate">{initiative.description}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Tab bar */}
      <div
        className="px-6 shrink-0 overflow-x-auto"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="flex gap-1 min-w-max">
          {TABS.map(({ key, label, icon: Icon }) => {
            const isActive = activeTab === key
            return (
              <button
                key={key}
                onClick={() => navigate(`/initiatives/${id}/${key}`)}
                className="relative flex items-center gap-1.5 px-3 py-3 text-xs font-medium transition-colors"
                style={{ color: isActive ? '#22d3ee' : '#64748b' }}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
                {isActive && (
                  <motion.div
                    layoutId="initiative-tab-indicator"
                    className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                    style={{ background: '#22d3ee' }}
                  />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="p-6"
          >
            {activeTab === 'overview' && <OverviewTab initiative={initiative} />}
            {activeTab === 'workflow' && <WorkflowTab initiativeId={id!} />}
            {activeTab === 'tasks' && (
              <PlaceholderTab icon={CheckSquare} label="Tasks" description="Human tasks generated by this initiative's workflow." />
            )}
            {activeTab === 'approvals' && (
              <PlaceholderTab icon={ThumbsUp} label="Approvals" description="Approval requests associated with this initiative." />
            )}
            {activeTab === 'consumables' && (
              <PlaceholderTab icon={Package} label="Consumables" description="Typed versioned artifacts produced by this workflow." />
            )}
            {activeTab === 'agents' && (
              <PlaceholderTab icon={Bot} label="Agents" description="AI agent runs and their outputs awaiting review." />
            )}
            {activeTab === 'tools' && (
              <PlaceholderTab icon={Wrench} label="Tools" description="Tool runs requested through the Tool Gateway." />
            )}
            {activeTab === 'receipts' && (
              <PlaceholderTab icon={Receipt} label="Receipts" description="Immutable audit receipts for all governed actions." />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

// ─── Workflow Tab ────────────────────────────────────────────────────────────

type WorkflowInstance = {
  id: string
  name: string
  status: string
  createdAt: string
  startedAt?: string
  completedAt?: string
}

function WorkflowTab({ initiativeId }: { initiativeId: string }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['workflow-instances', { initiativeId }],
    queryFn: () => api.get(`/workflow-instances?initiativeId=${initiativeId}`).then(r => r.data),
  })

  const instances: WorkflowInstance[] = data?.content ?? (Array.isArray(data) ? data : [])

  const create = useMutation({
    mutationFn: (name: string) =>
      api.post('/workflow-instances', { name, initiativeId }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['workflow-instances', { initiativeId }] })
      setCreating(false)
      setNewName('')
      navigate(`/runs/${res.data.id}`)
    },
  })

  if (isLoading) {
    return (
      <div className="space-y-2 max-w-2xl">
        {Array.from({ length: 2 }).map((_, i) => <div key={i} className="skeleton h-16 rounded-xl" />)}
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      {/* Header row */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-400">
          {instances.length} workflow{instances.length !== 1 ? 's' : ''} · click to open designer
        </p>
        <button
          className="btn-primary flex items-center gap-2 text-xs"
          onClick={() => setCreating(true)}
        >
          <Plus className="w-3.5 h-3.5" />
          New Workflow
        </button>
      </div>

      {/* Create inline form */}
      <AnimatePresence>
        {creating && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="mb-3 overflow-hidden"
          >
            <div
              className="glass-card rounded-xl p-4 flex items-center gap-3"
              style={{ border: '1px solid rgba(34,211,238,0.2)' }}
            >
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) create.mutate(newName.trim()) }}
                placeholder="Workflow name…"
                className="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-600 outline-none"
              />
              <button
                className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5"
                onClick={() => create.mutate(newName.trim())}
                disabled={!newName.trim() || create.isPending}
              >
                {create.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                Create & Open
              </button>
              <button
                className="w-6 h-6 flex items-center justify-center text-slate-600 hover:text-slate-300 transition-colors"
                onClick={() => { setCreating(false); setNewName('') }}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Instance list */}
      <div className="space-y-2">
        {instances.map((inst, i) => {
          const clr = statusColor[inst.status] ?? '#64748b'
          return (
            <motion.div
              key={inst.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, delay: i * 0.04 }}
              className="glass-card rounded-xl p-4 hover:bg-white/[0.03] cursor-pointer transition-all duration-200 group"
              style={{ border: '1px solid rgba(255,255,255,0.06)' }}
              onClick={() => navigate(`/runs/${inst.id}`)}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: `${clr}12`, border: `1px solid ${clr}20` }}
                >
                  <GitBranch className="w-3.5 h-3.5" style={{ color: clr }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-200 group-hover:text-white transition-colors truncate">
                    {inst.name}
                  </p>
                  <p className="text-xs text-slate-600 font-mono mt-0.5">
                    Created {new Date(inst.createdAt).toLocaleDateString()}
                    {inst.startedAt && ` · Started ${new Date(inst.startedAt).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className="text-xs font-mono px-2 py-0.5 rounded-md"
                    style={{ background: `${clr}12`, color: clr, border: `1px solid ${clr}20` }}
                  >
                    {inst.status}
                  </span>
                  <ExternalLink className="w-3.5 h-3.5 text-slate-700 group-hover:text-slate-400 transition-colors" />
                </div>
              </div>
            </motion.div>
          )
        })}

        {instances.length === 0 && !creating && (
          <div
            className="rounded-xl py-14 text-center"
            style={{ border: '1px dashed rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.01)' }}
          >
            <GitBranch className="w-10 h-10 text-slate-700 mx-auto mb-3" />
            <p className="text-slate-400 text-sm font-semibold">No workflows yet</p>
            <p className="text-slate-600 text-xs mt-1">Create one to design and run this initiative's workflow</p>
            <button
              className="btn-primary mt-4 flex items-center gap-2 mx-auto text-xs"
              onClick={() => setCreating(true)}
            >
              <Plus className="w-3.5 h-3.5" />
              New Workflow
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

type InitiativeData = { id: string; title: string; description?: string; status: string; createdAt: string }

function OverviewTab({ initiative }: { initiative: InitiativeData | undefined }) {
  if (!initiative) return null
  const statusClr = statusColor[initiative.status] ?? '#64748b'

  return (
    <div className="max-w-lg space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: 'Status', value: initiative.status, mono: true, color: statusClr },
          { label: 'Created', value: new Date(initiative.createdAt).toLocaleDateString() },
        ].map(({ label, value, mono, color }) => (
          <div key={label} className="glass-card rounded-xl p-4" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="label-xs mb-1">{label}</p>
            <p className={`text-sm font-semibold ${mono ? 'font-mono' : ''}`} style={color ? { color } : { color: '#e2e8f0' }}>
              {value}
            </p>
          </div>
        ))}
      </div>
      <div className="glass-card rounded-xl p-4" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
        <p className="label-xs mb-1">Description</p>
        <p className="text-sm text-slate-300">{initiative.description ?? '—'}</p>
      </div>
    </div>
  )
}

// ─── Placeholder Tab ──────────────────────────────────────────────────────────

function PlaceholderTab({ icon: Icon, label, description }: { icon: React.ElementType; label: string; description: string }) {
  return (
    <div className="rounded-xl py-16 text-center" style={{ border: '1px dashed rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.01)' }}>
      <Icon className="w-10 h-10 text-slate-700 mx-auto mb-3" />
      <p className="text-slate-400 text-sm font-semibold">{label}</p>
      <p className="text-slate-600 text-xs mt-1 max-w-xs mx-auto">{description}</p>
    </div>
  )
}
