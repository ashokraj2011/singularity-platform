import { useState, useRef, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  GitBranch, ExternalLink, Plus, MoreHorizontal, Trash2,
  Archive, ArchiveRestore, Download, FileCode, Layers,
  Tag, ChevronDown, X, Upload, Play, PenLine, GitFork,
  Bot, Braces, UserCheck,
} from 'lucide-react'
import { api } from '../../lib/api'
import { useActiveContextStore } from '../../store/activeContext.store'
import { UserPicker, TeamPicker, CapabilityPicker } from '../../components/lookup/EntityPickers'

type WorkflowInstance = {
  id: string
  name: string
  status: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  archivedAt?: string
  templateId?: string | null
  templateVersion?: number | null
  isDesign?: boolean
}

type TemplateMetadata = {
  teamName?: string
  globallyAvailable?: boolean
  workflowType?: string
  domain?: string
  criticality?: string
  executionTarget?: string
  visibility?: string
  dataSensitivity?: string
  requiresApprovalToRun?: boolean
  slaHours?: number
  owner?: string
  tags?: { key: string; value: string }[]
}

type TemplateVariableDef = {
  key: string
  label?: string
  type?: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON'
  defaultValue?: unknown
  description?: string
  scope?: 'INPUT' | 'CONSTANT'
}

type WorkflowStarter = 'EMPTY' | 'CAPABILITY_WORKBENCH_BRIDGE'

type WorkflowTemplate = {
  id: string
  name: string
  description?: string
  status?: string
  metadata?: TemplateMetadata
  createdAt: string
  archivedAt?: string
  currentVersion: number
  variables?: TemplateVariableDef[]
}

const WORKFLOW_TYPES = ['SDLC', 'BUSINESS', 'DATA_PIPELINE', 'INFRASTRUCTURE', 'COMPLIANCE', 'OTHER'] as const
const DOMAINS = ['Engineering', 'Finance', 'Marketing', 'HR', 'Operations', 'Security', 'Legal', 'Product', 'Data', 'Other']
const CRITICALITY_OPTS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
const EXECUTION_TARGETS = ['SERVER', 'CLIENT', 'ALL'] as const
const VISIBILITY_OPTS = ['GLOBAL', 'TEAM', 'PRIVATE'] as const
const DATA_SENSITIVITY = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const

const CRITICALITY_COLOR: Record<string, string> = { CRITICAL: '#ef4444', HIGH: '#f97316', MEDIUM: '#eab308', LOW: '#22c55e' }
const TYPE_LABEL: Record<string, string> = { SDLC: 'SDLC', BUSINESS: 'Business', DATA_PIPELINE: 'Data Pipeline', INFRASTRUCTURE: 'Infrastructure', COMPLIANCE: 'Compliance', OTHER: 'Other' }

function emptyMeta(): TemplateMetadata {
  return {
    globallyAvailable: false, workflowType: 'BUSINESS', domain: 'Engineering',
    criticality: 'MEDIUM', executionTarget: 'SERVER', visibility: 'TEAM',
    dataSensitivity: 'INTERNAL', requiresApprovalToRun: false, tags: [],
  }
}

const STATUS_COLOR: Record<string, string> = {
  DRAFT:     '#6a7486',
  ACTIVE:    '#00843D',
  PAUSED:    '#d97706',
  COMPLETED: '#10b981',
  CANCELLED: '#dc2626',
  FAILED:    '#ba1a1a',
}

const STARTER_OPTIONS: Array<{
  value: WorkflowStarter
  title: string
  description: string
  Icon: typeof GitBranch
  accent: string
}> = [
  {
    value: 'EMPTY',
    title: 'Empty canvas',
    description: 'Start with a blank workflow and add nodes manually.',
    Icon: GitBranch,
    accent: '#64748b',
  },
  {
    value: 'CAPABILITY_WORKBENCH_BRIDGE',
    title: 'Agent → Workbench → Human approval',
    description: 'Creates a capability-scoped flow where an agent prepares context, the Workbench produces approved artifacts, and a human signs off.',
    Icon: Braces,
    accent: '#7c3aed',
  },
]

// ─── Shared form primitives ──────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 11px',
  borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13,
  outline: 'none', fontFamily: 'inherit', color: '#0f172a',
  transition: 'border-color 0.12s',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#64748b', marginBottom: 5 }}>
        {label}
      </p>
      {children}
    </div>
  )
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div style={{ position: 'relative' }}>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ ...inputStyle, appearance: 'none', paddingRight: 28, cursor: 'pointer' }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown size={13} style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', pointerEvents: 'none' }} />
    </div>
  )
}

function MetaBadge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      background: `${color}18`, color, border: `1px solid ${color}28`,
    }}>
      {children}
    </span>
  )
}

// ─── Row action menu — instances ─────────────────────────────────────────────

function InstanceMenu({
  onDelete, onArchive,
}: {
  onDelete: () => void
  onArchive: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        title="More actions"
        style={{
          width: 28, height: 28, borderRadius: 7, border: 'none',
          background: open ? 'var(--color-surface-container)' : 'transparent',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--color-outline)', transition: 'background 0.12s',
        }}
        onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--color-surface-container)')}
        onMouseLeave={e => { if (!open) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 34, zIndex: 50,
          background: '#fff', border: '1px solid var(--color-outline-variant)',
          borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          minWidth: 160, overflow: 'hidden',
        }}>
          <button
            onClick={e => { e.stopPropagation(); setOpen(false); onArchive() }}
            style={{
              width: '100%', padding: '9px 14px', border: 'none',
              background: 'transparent', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 12, fontWeight: 600, color: '#d97706',
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = '#fffbeb')}
            onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
          >
            <Archive size={13} />
            Archive
          </button>
          <button
            onClick={e => { e.stopPropagation(); setOpen(false); onDelete() }}
            style={{
              width: '100%', padding: '9px 14px', border: 'none',
              background: 'transparent', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 12, fontWeight: 600, color: '#dc2626',
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = '#fef2f2')}
            onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
          >
            <Trash2 size={13} />
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Template row menu ────────────────────────────────────────────────────────

function TemplateMenu({
  template,
  onArchive,
  onRestore,
  onExportJson,
  onExportBpmn,
  onPublish,
  onMarkFinal,
  onDuplicate,
}: {
  template: WorkflowTemplate
  onArchive: () => void
  onRestore: () => void
  onExportJson: () => void
  onExportBpmn: () => void
  onPublish: () => void
  onMarkFinal: () => void
  onDuplicate: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const menuBtn = (label: string, Icon: React.ElementType, color: string, hoverBg: string, action: () => void) => (
    <button
      onClick={e => { e.stopPropagation(); setOpen(false); action() }}
      style={{
        width: '100%', padding: '9px 14px', border: 'none',
        background: 'transparent', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 12, fontWeight: 600, color,
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = hoverBg)}
      onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
    >
      <Icon size={13} />
      {label}
    </button>
  )

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        title="More actions"
        style={{
          width: 28, height: 28, borderRadius: 7, border: 'none',
          background: open ? 'var(--color-surface-container)' : 'transparent',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--color-outline)', transition: 'background 0.12s',
        }}
        onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--color-surface-container)')}
        onMouseLeave={e => { if (!open) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 34, zIndex: 50,
          background: '#fff', border: '1px solid var(--color-outline-variant)',
          borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          minWidth: 180, overflow: 'hidden',
        }}>
          {!template.archivedAt && template.status === 'DRAFT' && (
            <>
              {menuBtn('Publish', GitBranch, '#22c55e', '#f0fdf4', onPublish)}
              {menuBtn('Mark as Final', FileCode, '#8b5cf6', '#f5f3ff', onMarkFinal)}
            </>
          )}
          {!template.archivedAt && template.status === 'PUBLISHED' && (
            menuBtn('Mark as Final', FileCode, '#8b5cf6', '#f5f3ff', onMarkFinal)
          )}
          {!template.archivedAt && menuBtn('Duplicate', GitBranch, '#38bdf8', '#f0f9ff', onDuplicate)}
          {menuBtn('Export JSON', Download, '#475569', '#f8fafc', onExportJson)}
          {menuBtn('Export BPMN', FileCode, '#6366f1', '#eef2ff', onExportBpmn)}
          {template.archivedAt
            ? menuBtn('Restore', ArchiveRestore, '#00843D', '#f0fdf4', onRestore)
            : menuBtn('Archive', Archive, '#d97706', '#fffbeb', onArchive)
          }
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function WorkflowsListPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const qc = useQueryClient()
  const [tab, setTab] = useState<'instances' | 'templates'>('templates')
  const [showArchived, setShowArchived] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<WorkflowInstance | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importXml, setImportXml] = useState('')
  const [importName, setImportName] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const activeContext = useActiveContextStore(s => s.active)
  const [createCapabilityId, setCreateCapabilityId] = useState<string>(activeContext?.capabilityId ?? '')
  const [createTeamId, setCreateTeamId] = useState<string>(activeContext?.teamId ?? '')
  const [createStarter, setCreateStarter] = useState<WorkflowStarter>('EMPTY')
  const [createDesc, setCreateDesc] = useState('')
  const [createMeta, setCreateMeta] = useState<TemplateMetadata>(emptyMeta())
  const [createStep, setCreateStep] = useState<'identity' | 'config' | 'tags'>('identity')
  const [duplicateOpen, setDuplicateOpen] = useState<WorkflowTemplate | null>(null)
  const [duplicateName, setDuplicateName] = useState('')
  const [duplicateAsNewVersion, setDuplicateAsNewVersion] = useState(false)
  const [importJsonOpen, setImportJsonOpen] = useState(false)
  const [importJsonText, setImportJsonText] = useState('')
  const importJsonFileRef = useRef<HTMLInputElement>(null)

  const { data: instancesData, isLoading: instancesLoading } = useQuery({
    queryKey: ['workflow-instances'],
    queryFn: () => api.get('/workflow-instances').then(r => r.data),
    refetchInterval: 10_000,
  })

  const { data: templatesData, isLoading: templatesLoading } = useQuery({
    queryKey: ['workflow-templates', showArchived],
    queryFn: () => api.get(showArchived ? '/workflow-templates?archived=true' : '/workflow-templates').then(r => r.data),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/workflow-instances/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-instances'] })
      setConfirmDelete(null)
    },
  })

  const archiveInstanceMut = useMutation({
    mutationFn: (id: string) => api.post(`/workflow-instances/${id}/archive`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-instances'] }),
  })

  const archiveTemplateMut = useMutation({
    mutationFn: (id: string) => api.post(`/workflow-templates/${id}/archive`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-templates'] }),
  })

  const restoreTemplateMut = useMutation({
    mutationFn: (id: string) => api.post(`/workflow-templates/${id}/restore`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-templates'] }),
  })

  const publishTemplateMut = useMutation({
    mutationFn: (id: string) => api.post(`/workflow-templates/${id}/publish`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-templates'] }),
  })

  const markFinalTemplateMut = useMutation({
    mutationFn: (id: string) => api.post(`/workflow-templates/${id}/mark-final`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-templates'] }),
  })

  const duplicateTemplateMut = useMutation({
    mutationFn: (data: { sourceId: string; name: string; asNewVersion: boolean }) =>
      api.post(`/workflow-templates/${data.sourceId}/duplicate`, { name: data.name, asNewVersion: data.asNewVersion }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-templates'] })
      setDuplicateOpen(null)
      setDuplicateName('')
      setDuplicateAsNewVersion(false)
    },
  })

  const importBpmnMut = useMutation({
    mutationFn: ({ name, xml }: { name: string; xml: string }) =>
      api.post('/workflow-templates/import-bpmn', { name, xml }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-templates'] })
      setImportOpen(false)
      setImportXml('')
      setImportName('')
    },
  })

  const importJsonMut = useMutation({
    mutationFn: (doc: object) =>
      api.post('/workflow-templates/import', doc).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-templates'] })
      setImportJsonOpen(false)
      setImportJsonText('')
      setTab('templates')
    },
  })

  const createWorkflowMut = useMutation({
    mutationFn: ({ name, description, metadata, capabilityId, teamId, starter }: { name: string; description: string; metadata: TemplateMetadata; capabilityId?: string; teamId?: string; starter: WorkflowStarter }) =>
      api.post('/workflow-templates', { name, description, metadata, capabilityId, teamId, starter }).then(r => r.data as { id: string; designInstanceId?: string }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['workflow-templates'] })
      setCreateOpen(false)
      setCreateName('')
      setCreateDesc('')
      setCreateMeta(emptyMeta())
      setCreateCapabilityId('')
      setCreateTeamId('')
      setCreateStarter('EMPTY')
      setCreateStep('identity')
      setTab('templates')
      // Drop the user straight into the studio, on the freshly-created design.
      // Workflow now owns its design directly — navigate to the design editor
      // route which talks to /workflow-templates/:id/design/...
      if (created?.id) navigate(`/design/${created.id}`)
    },
  })

  // ── Open the design editor for a workflow.
  // Synchronous now — the workflow IS the design, so we navigate directly.
  const openDesign = (workflowId: string) => navigate(`/design/${workflowId}`)
  const openDesignMut = { mutate: openDesign, isPending: false }

  // ── Start a run (clones the design into a fresh instance).  Opened via the
  // RunModal so the operator can name the run and override INPUT vars / per-
  // instance globals before starting.
  const [runOpen, setRunOpen] = useState<WorkflowTemplate | null>(null)
  const startRunMut = useMutation({
    mutationFn: ({ workflowId, body }: { workflowId: string; body: { name?: string; vars?: Record<string, unknown>; globals?: Record<string, unknown> } }) =>
      api.post(`/workflow-templates/${workflowId}/runs`, body).then(r => r.data as { id: string }),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ['workflow-instances'] })
      qc.invalidateQueries({ queryKey: ['template-runs'] })
      setRunOpen(null)
      navigate(`/runs/${run.id}`)
    },
  })

  const allInstances: WorkflowInstance[] = instancesData?.content ?? (Array.isArray(instancesData) ? instancesData : [])
  // The "instances" tab shows runs only — design instances are editable from
  // the template card's "Edit" action, not as standalone rows.
  const instances: WorkflowInstance[] = allInstances.filter(i => !i.isDesign)
  // Run-count map used to badge each template in the templates tab.
  const runCountByTemplate: Record<string, number> = {}
  for (const inst of instances) {
    if (inst.templateId) runCountByTemplate[inst.templateId] = (runCountByTemplate[inst.templateId] ?? 0) + 1
  }
  const templates: WorkflowTemplate[] = Array.isArray(templatesData) ? templatesData : (templatesData?.content ?? [])
  const starterRequiresCapability = createStarter === 'CAPABILITY_WORKBENCH_BRIDGE' && !createCapabilityId
  const canAdvanceCreateIdentity = createName.trim().length > 0 && !starterRequiresCapability

  // ?run=:workflowId — open the Run modal automatically (deep-link from the
  // design studio's "Start Run" button).
  useEffect(() => {
    const id = searchParams.get('run')
    if (!id || runOpen) return
    const tmpl = templates.find(t => t.id === id)
    if (tmpl) {
      setRunOpen(tmpl)
      // Clear the query so closing the modal doesn't reopen it.
      const next = new URLSearchParams(searchParams)
      next.delete('run')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, templates, runOpen, setSearchParams])

  const active = instances.filter(i => i.status === 'ACTIVE').length
  const draft  = instances.filter(i => i.status === 'DRAFT').length

  async function downloadJson(id: string, name: string) {
    const data = await api.get(`/workflow-templates/${id}/export`).then(r => r.data)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `workflow-${name.replace(/\s+/g, '-')}.json`
    a.click(); URL.revokeObjectURL(url)
  }

  async function downloadBpmn(id: string, name: string) {
    const xml = await api.get(`/workflow-templates/${id}/export-bpmn`, { responseType: 'text' }).then(r => r.data)
    const blob = new Blob([xml], { type: 'application/xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `workflow-${name.replace(/\s+/g, '-')}.bpmn`
    a.click(); URL.revokeObjectURL(url)
  }

  const TabBtn = ({ id, label }: { id: 'instances' | 'templates'; label: string }) => (
    <button
      onClick={() => setTab(id)}
      style={{
        padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
        fontSize: 12, fontWeight: 700,
        background: tab === id ? 'rgba(0,132,61,0.10)' : 'transparent',
        color: tab === id ? 'var(--color-primary)' : 'var(--color-outline)',
        transition: 'all 0.12s',
      }}
    >
      {label}
    </button>
  )

  return (
    <div style={{ padding: '28px 28px 40px', maxWidth: 860 }}>

      {/* Page header */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,132,61,0.10)', border: '1px solid rgba(0,132,61,0.18)',
              }}>
                <GitBranch size={16} style={{ color: 'var(--color-primary)' }} />
              </div>
              <h1 className="page-header">Workflow Manager</h1>
            </div>
            <p style={{ fontSize: 12, color: 'var(--color-outline)', fontFamily: 'monospace' }}>
              {instances.length} workflows · {active} active · {draft} draft
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {tab === 'templates' && (
              <>
                <button
                  onClick={() => setImportJsonOpen(true)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
                    padding: '8px 14px', borderRadius: 8, border: '1px solid var(--color-outline-variant)',
                    background: 'transparent', cursor: 'pointer', color: 'var(--color-outline)',
                    fontWeight: 600,
                  }}
                >
                  <Upload size={14} />
                  Import JSON
                </button>
                <button
                  onClick={() => setImportOpen(true)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
                    padding: '8px 14px', borderRadius: 8, border: '1px solid var(--color-outline-variant)',
                    background: 'transparent', cursor: 'pointer', color: 'var(--color-outline)',
                    fontWeight: 600,
                  }}
                >
                  <FileCode size={14} />
                  Import BPMN
                </button>
              </>
            )}
            <button
              className="btn-primary"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={14} />
              New workflow
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4, marginBottom: 16,
          background: 'var(--color-surface-container)', borderRadius: 10, padding: 4,
          width: 'fit-content',
        }}>
          <TabBtn id="templates" label="Workflows" />
          <TabBtn id="instances" label="Runs" />
        </div>
      </motion.div>

      {/* ── INSTANCES TAB ── */}
      {tab === 'instances' && (
        instancesLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 64, borderRadius: 12 }} />)}
          </div>
        ) : instances.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <GitBranch size={20} style={{ color: 'var(--color-primary)' }} />
            </div>
            <p style={{ fontFamily: "'Public Sans', sans-serif", fontWeight: 700, fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 4 }}>
              No workflows yet
            </p>
            <p style={{ fontSize: 12, color: 'var(--color-outline)', marginBottom: 16 }}>
              Create a workflow to start designing and running automated processes.
            </p>
            <button className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }} onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> New workflow
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {instances.map((inst, i) => {
              const clr = STATUS_COLOR[inst.status] ?? '#6a7486'
              return (
                <motion.div
                  key={inst.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: i * 0.04 }}
                  onClick={() => navigate(`/runs/${inst.id}`)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 14,
                    padding: '14px 16px', borderRadius: 12, cursor: 'pointer',
                    background: '#ffffff', border: '1px solid var(--color-outline-variant)',
                    boxShadow: '0 2px 8px rgba(12,23,39,0.04)',
                    transition: 'all 0.15s',
                    opacity: inst.archivedAt ? 0.5 : 1,
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(0,132,61,0.3)'
                    ;(e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(0,132,61,0.08)'
                    ;(e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)'
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-outline-variant)'
                    ;(e.currentTarget as HTMLDivElement).style.boxShadow = '0 2px 8px rgba(12,23,39,0.04)'
                    ;(e.currentTarget as HTMLDivElement).style.transform = 'none'
                  }}
                >
                  <div style={{
                    width: 36, height: 36, borderRadius: 9, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: `${clr}12`, border: `1px solid ${clr}25`,
                  }}>
                    <GitBranch size={15} style={{ color: clr }} />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{
                      fontFamily: "'Public Sans', sans-serif",
                      fontSize: 13, fontWeight: 700,
                      color: 'var(--color-on-surface)', whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {inst.name}
                    </p>
                    <p style={{ fontSize: 11, color: 'var(--color-outline)', fontFamily: 'monospace', marginTop: 2 }}>
                      Created {new Date(inst.createdAt).toLocaleDateString()}
                      {inst.startedAt && ` · Started ${new Date(inst.startedAt).toLocaleDateString()}`}
                    </p>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {typeof inst.templateVersion === 'number' && (
                      <span title={`Cloned from design v${inst.templateVersion}`} style={{
                        fontSize: 9, fontWeight: 700,
                        padding: '3px 8px', borderRadius: 6,
                        background: 'rgba(99,102,241,0.10)', color: '#6366f1',
                        border: '1px solid rgba(99,102,241,0.20)',
                        fontFamily: 'monospace',
                      }}>
                        v{inst.templateVersion}
                      </span>
                    )}
                    <span style={{
                      fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '0.14em', padding: '3px 8px', borderRadius: 6,
                      background: `${clr}12`, color: clr, border: `1px solid ${clr}25`,
                      fontFamily: 'monospace',
                    }}>
                      {inst.status}
                    </span>
                    <ExternalLink size={13} style={{ color: 'var(--color-outline-variant)' }} />
                    <InstanceMenu
                      onDelete={() => setConfirmDelete(inst)}
                      onArchive={() => archiveInstanceMut.mutate(inst.id)}
                    />
                  </div>
                </motion.div>
              )
            })}
          </div>
        )
      )}

      {/* ── TEMPLATES TAB ── */}
      {tab === 'templates' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <p style={{ fontSize: 11, color: 'var(--color-outline)' }}>
              {templates.length} workflow{templates.length !== 1 ? 's' : ''} · designs your team can run
            </p>
            <button
              onClick={() => setShowArchived(a => !a)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '4px 10px', borderRadius: 6, border: '1px solid var(--color-outline-variant)',
                background: showArchived ? 'rgba(217,119,6,0.08)' : 'transparent',
                fontSize: 11, fontWeight: 600, color: showArchived ? '#d97706' : 'var(--color-outline)',
                cursor: 'pointer',
              }}
            >
              <Archive size={11} />
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
          </div>

          {templatesLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 64, borderRadius: 12 }} />)}
            </div>
          ) : templates.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Layers size={20} style={{ color: 'var(--color-primary)' }} />
              </div>
              <p style={{ fontFamily: "'Public Sans', sans-serif", fontWeight: 700, fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 4 }}>
                No workflows yet
              </p>
              <p style={{ fontSize: 12, color: 'var(--color-outline)' }}>
                Create a workflow from scratch, or import a BPMN / JSON design.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {templates.map((tmpl, i) => (
                <motion.div
                  key={tmpl.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: i * 0.04 }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 14,
                    padding: '14px 16px', borderRadius: 12,
                    background: '#ffffff', border: '1px solid var(--color-outline-variant)',
                    boxShadow: '0 2px 8px rgba(12,23,39,0.04)',
                    opacity: tmpl.archivedAt ? 0.55 : 1,
                  }}
                >
                  <div style={{
                    width: 36, height: 36, borderRadius: 9, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(99,102,241,0.10)', border: '1px solid rgba(99,102,241,0.18)',
                  }}>
                    <Layers size={15} style={{ color: '#6366f1' }} />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <p style={{
                        fontFamily: "'Public Sans', sans-serif",
                        fontSize: 13, fontWeight: 700,
                        color: 'var(--color-on-surface)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {tmpl.name}
                      </p>
                      {tmpl.archivedAt && (
                        <span style={{
                          fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                          padding: '2px 6px', borderRadius: 4, letterSpacing: '0.12em',
                          background: 'rgba(217,119,6,0.10)', color: '#d97706',
                          border: '1px solid rgba(217,119,6,0.2)',
                        }}>
                          Archived
                        </span>
                      )}
                    </div>
                    <p style={{ fontSize: 11, color: 'var(--color-outline)', fontFamily: 'monospace', marginTop: 2 }}>
                      v{tmpl.currentVersion} · Created {new Date(tmpl.createdAt).toLocaleDateString()}
                      {(runCountByTemplate[tmpl.id] ?? 0) > 0 && (
                        <>
                          {' · '}
                          <span style={{ color: '#0ea5e9', fontWeight: 700 }}>
                            <GitFork size={9} style={{ display: 'inline', marginRight: 2, verticalAlign: 'middle' }} />
                            {runCountByTemplate[tmpl.id]} run{runCountByTemplate[tmpl.id] === 1 ? '' : 's'}
                          </span>
                        </>
                      )}
                      {tmpl.description && ` · ${tmpl.description}`}
                    </p>
                    {/* Metadata badges */}
                    {tmpl.metadata && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                        {tmpl.metadata.workflowType && (
                          <MetaBadge color="#6366f1">{TYPE_LABEL[tmpl.metadata.workflowType] ?? tmpl.metadata.workflowType}</MetaBadge>
                        )}
                        {tmpl.metadata.criticality && (
                          <MetaBadge color={CRITICALITY_COLOR[tmpl.metadata.criticality] ?? '#64748b'}>{tmpl.metadata.criticality}</MetaBadge>
                        )}
                        {tmpl.metadata.domain && (
                          <MetaBadge color="#0ea5e9">{tmpl.metadata.domain}</MetaBadge>
                        )}
                        {tmpl.metadata.executionTarget && tmpl.metadata.executionTarget !== 'SERVER' && (
                          <MetaBadge color="#f97316">{tmpl.metadata.executionTarget}</MetaBadge>
                        )}
                        {tmpl.metadata.globallyAvailable && (
                          <MetaBadge color="#22c55e">Global</MetaBadge>
                        )}
                        {tmpl.metadata.requiresApprovalToRun && (
                          <MetaBadge color="#f59e0b">Approval req.</MetaBadge>
                        )}
                        {tmpl.metadata.slaHours && (
                          <MetaBadge color="#94a3b8">SLA {tmpl.metadata.slaHours}h</MetaBadge>
                        )}
                        {(tmpl.metadata.tags ?? []).map((t, i) => (
                          <MetaBadge key={i} color="#a78bfa">{t.key}: {t.value}</MetaBadge>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Primary actions: Edit Design / Start Run */}
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      onClick={() => openDesignMut.mutate(tmpl.id)}
                      disabled={openDesignMut.isPending || !!tmpl.archivedAt}
                      title="Open the editable design for this workflow"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5,
                        padding: '6px 11px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                        border: '1px solid var(--color-outline-variant)',
                        background: '#fff',
                        color: tmpl.archivedAt ? 'var(--color-outline)' : 'var(--color-on-surface)',
                        cursor: tmpl.archivedAt ? 'default' : 'pointer',
                      }}
                    >
                      <PenLine size={11} /> Edit
                    </button>
                    <button
                      onClick={() => setRunOpen(tmpl)}
                      disabled={!!tmpl.archivedAt}
                      title="Start a new run of this workflow"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5,
                        padding: '6px 11px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                        border: 'none',
                        background: tmpl.archivedAt ? 'var(--color-outline-variant)' : 'var(--color-primary)',
                        color: '#fff',
                        cursor: tmpl.archivedAt ? 'default' : 'pointer',
                      }}
                    >
                      <Play size={11} /> Run
                    </button>
                  </div>

                  <TemplateMenu
                    template={tmpl}
                    onArchive={() => archiveTemplateMut.mutate(tmpl.id)}
                    onRestore={() => restoreTemplateMut.mutate(tmpl.id)}
                    onExportJson={() => downloadJson(tmpl.id, tmpl.name)}
                    onExportBpmn={() => downloadBpmn(tmpl.id, tmpl.name)}
                    onPublish={() => publishTemplateMut.mutate(tmpl.id)}
                    onMarkFinal={() => markFinalTemplateMut.mutate(tmpl.id)}
                    onDuplicate={() => { setDuplicateOpen(tmpl); setDuplicateName(`${tmpl.name} (copy)`); setDuplicateAsNewVersion(false) }}
                  />
                </motion.div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Run modal — name + optional vars/globals overrides */}
      {runOpen && (
        <RunModal
          workflow={runOpen}
          submitting={startRunMut.isPending}
          error={startRunMut.error}
          onCancel={() => setRunOpen(null)}
          onSubmit={(body) => startRunMut.mutate({ workflowId: runOpen.id, body })}
          onSubmitBrowser={(body) => {
            const params = new URLSearchParams()
            params.set('workflowId', runOpen.id)
            if (body.name)    params.set('name', body.name)
            if (body.vars)    params.set('vars',    encodeURIComponent(JSON.stringify(body.vars)))
            if (body.globals) params.set('globals', encodeURIComponent(JSON.stringify(body.globals)))
            setRunOpen(null)
            navigate(`/play/new?${params.toString()}`)
          }}
        />
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div
          onClick={() => setConfirmDelete(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 200, backdropFilter: 'blur(4px)',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 16, padding: '28px 28px 24px',
              boxShadow: '0 24px 64px rgba(0,0,0,0.2)', maxWidth: 380, width: '100%',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, background: '#fef2f2',
                border: '1px solid #fecaca', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <Trash2 size={18} style={{ color: '#dc2626' }} />
              </div>
              <div>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 2 }}>Delete workflow?</p>
                <p style={{ fontSize: 12, color: '#64748b' }}>This cannot be undone.</p>
              </div>
            </div>
            <p style={{
              fontSize: 12, color: '#475569', background: '#f8fafc',
              border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 12px', marginBottom: 20,
            }}>
              <strong>{confirmDelete.name}</strong>
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-outline-variant)',
                  background: 'transparent', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#475569',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMut.mutate(confirmDelete.id)}
                disabled={deleteMut.isPending}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none',
                  background: '#dc2626', color: '#fff', fontSize: 12, fontWeight: 700,
                  cursor: deleteMut.isPending ? 'not-allowed' : 'pointer',
                  opacity: deleteMut.isPending ? 0.7 : 1,
                }}
              >
                {deleteMut.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New workflow modal — rich creation form */}
      {createOpen && (
        <div
          onClick={() => { setCreateOpen(false); setCreateStep('identity') }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 200, backdropFilter: 'blur(6px)',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 20, boxShadow: '0 32px 72px rgba(0,0,0,0.22)',
              width: '100%', maxWidth: 560, maxHeight: '92vh', display: 'flex', flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Header */}
            <div style={{ padding: '24px 28px 0', borderBottom: '1px solid #f1f5f9' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{
                    width: 42, height: 42, borderRadius: 11,
                    background: 'rgba(0,132,61,0.10)', border: '1px solid rgba(0,132,61,0.20)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <GitBranch size={18} style={{ color: '#00843D' }} />
                  </div>
                  <div>
                    <p style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', margin: 0 }}>New Workflow</p>
                    <p style={{ fontSize: 12, color: '#64748b', margin: '2px 0 0' }}>Configure metadata before designing the flow</p>
                  </div>
                </div>
                <button onClick={() => { setCreateOpen(false); setCreateStep('identity') }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4, display: 'flex' }}>
                  <X size={18} />
                </button>
              </div>

              {/* Steps */}
              <div style={{ display: 'flex', gap: 0, marginBottom: -1 }}>
                {(['identity', 'config', 'tags'] as const).map((s, i) => {
                  const labels = ['Identity', 'Governance', 'Tags']
                  const active = createStep === s
                  return (
                    <button key={s} onClick={() => setCreateStep(s)} style={{
                      padding: '8px 16px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                      background: 'none', borderBottom: active ? '2px solid #00843D' : '2px solid transparent',
                      color: active ? '#00843D' : '#94a3b8', transition: 'all 0.12s',
                    }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 18, height: 18, borderRadius: '50%', fontSize: 10, fontWeight: 800,
                        background: active ? '#00843D' : '#e2e8f0', color: active ? '#fff' : '#64748b',
                        marginRight: 6,
                      }}>{i + 1}</span>
                      {labels[i]}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Body */}
            <div style={{ padding: '24px 28px', overflowY: 'auto', flex: 1 }}>

              {/* ── STEP 1: Identity ─────────────────────────────────── */}
              {createStep === 'identity' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <Field label="Workflow name *">
                    <input autoFocus value={createName} onChange={e => setCreateName(e.target.value)}
                      placeholder="e.g. Customer Onboarding"
                      style={inputStyle} />
                  </Field>
                  <Field label="Description">
                    <textarea value={createDesc} onChange={e => setCreateDesc(e.target.value)} rows={2}
                      placeholder="What does this workflow do?"
                      style={{ ...inputStyle, resize: 'vertical' }} />
                  </Field>
                  <Field label="Capability (owner)">
                    <CapabilityPicker
                      value={createCapabilityId}
                      onChange={v => setCreateCapabilityId(v)}
                      placeholder="Select a capability…"
                      hint="Federated from Identity & Access and Agent Studio. Membership capabilities are filtered to your access."
                    />
                    <p style={{ fontSize: 11, color: '#64748b', marginTop: 4, lineHeight: 1.4 }}>
                      Capability is the authorization boundary for view / edit / start.
                      Leave empty to fall back to team-based permissions.
                    </p>
                  </Field>
                  <Field label="Starter pattern">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      {STARTER_OPTIONS.map(option => {
                        const selected = createStarter === option.value
                        const Icon = option.Icon
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setCreateStarter(option.value)}
                            style={{
                              textAlign: 'left',
                              padding: 12,
                              borderRadius: 12,
                              border: selected ? `1.5px solid ${option.accent}` : '1px solid #e2e8f0',
                              background: selected ? `${option.accent}10` : '#fff',
                              color: '#0f172a',
                              cursor: 'pointer',
                              boxShadow: selected ? `0 10px 24px ${option.accent}16` : 'none',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                              <span style={{
                                width: 26, height: 26, borderRadius: 8,
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                background: `${option.accent}16`, color: option.accent,
                              }}>
                                <Icon size={14} />
                              </span>
                              <span style={{ fontSize: 12, fontWeight: 800 }}>{option.title}</span>
                            </div>
                            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45, color: '#64748b' }}>
                              {option.description}
                            </p>
                          </button>
                        )
                      })}
                    </div>
                    {createStarter === 'CAPABILITY_WORKBENCH_BRIDGE' && (
                      <div style={{
                        marginTop: 8,
                        padding: '9px 11px',
                        borderRadius: 10,
                        border: starterRequiresCapability ? '1px solid #fecaca' : '1px solid #ddd6fe',
                        background: starterRequiresCapability ? '#fef2f2' : '#f5f3ff',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 800, color: '#6d28d9' }}>
                            <Bot size={11} /> Agent context
                          </span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 800, color: '#7c3aed' }}>
                            <Braces size={11} /> Workbench artifacts
                          </span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 800, color: '#6d28d9' }}>
                            <UserCheck size={11} /> Human sign-off
                          </span>
                        </div>
                        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45, color: starterRequiresCapability ? '#b91c1c' : '#5b21b6' }}>
                          {starterRequiresCapability
                            ? 'Select a capability so the Workbench can bind derived agents and save its final pack against the correct boundary.'
                            : 'This creates Start → Agent Task → Workbench Task → Human Approval → Done. You can edit phases, agents, gates, and artifacts in the designer.'}
                        </p>
                      </div>
                    )}
                  </Field>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <Field label="Owning team">
                      <TeamPicker
                        value={createTeamId}
                        onChange={setCreateTeamId}
                        placeholder="Select a team…"
                      />
                    </Field>
                    <Field label="Owner / author">
                      <UserPicker
                        value={createMeta.owner ?? ''}
                        onChange={v => setCreateMeta(m => ({ ...m, owner: v || undefined }))}
                        emit="email"
                        placeholder="Select an owner…"
                      />
                    </Field>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <Field label="Workflow type">
                      <Select value={createMeta.workflowType ?? 'BUSINESS'}
                        onChange={v => setCreateMeta(m => ({ ...m, workflowType: v }))}
                        options={WORKFLOW_TYPES.map(t => ({ value: t, label: TYPE_LABEL[t] }))} />
                    </Field>
                    <Field label="Domain / category">
                      <Select value={createMeta.domain ?? 'Engineering'}
                        onChange={v => setCreateMeta(m => ({ ...m, domain: v }))}
                        options={DOMAINS.map(d => ({ value: d, label: d }))} />
                    </Field>
                  </div>
                </div>
              )}

              {/* ── STEP 2: Governance ──────────────────────────────── */}
              {createStep === 'config' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <Field label="Criticality">
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {CRITICALITY_OPTS.map(c => (
                          <button key={c} onClick={() => setCreateMeta(m => ({ ...m, criticality: c }))}
                            style={{
                              padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 700,
                              border: `1.5px solid ${createMeta.criticality === c ? CRITICALITY_COLOR[c] : '#e2e8f0'}`,
                              background: createMeta.criticality === c ? `${CRITICALITY_COLOR[c]}18` : '#f8fafc',
                              color: createMeta.criticality === c ? CRITICALITY_COLOR[c] : '#64748b',
                              cursor: 'pointer', transition: 'all 0.1s',
                            }}>
                            {c}
                          </button>
                        ))}
                      </div>
                    </Field>
                    <Field label="Visibility">
                      <div style={{ display: 'flex', gap: 6 }}>
                        {VISIBILITY_OPTS.map(v => (
                          <button key={v} onClick={() => setCreateMeta(m => ({ ...m, visibility: v }))}
                            style={{
                              padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 700,
                              border: `1.5px solid ${createMeta.visibility === v ? '#6366f1' : '#e2e8f0'}`,
                              background: createMeta.visibility === v ? 'rgba(99,102,241,0.10)' : '#f8fafc',
                              color: createMeta.visibility === v ? '#6366f1' : '#64748b',
                              cursor: 'pointer', transition: 'all 0.1s',
                            }}>
                            {v}
                          </button>
                        ))}
                      </div>
                    </Field>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <Field label="Execution target">
                      <div style={{ display: 'flex', gap: 6 }}>
                        {EXECUTION_TARGETS.map(t => (
                          <button key={t} onClick={() => setCreateMeta(m => ({ ...m, executionTarget: t }))}
                            style={{
                              padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 700,
                              border: `1.5px solid ${createMeta.executionTarget === t ? '#0ea5e9' : '#e2e8f0'}`,
                              background: createMeta.executionTarget === t ? 'rgba(14,165,233,0.10)' : '#f8fafc',
                              color: createMeta.executionTarget === t ? '#0ea5e9' : '#64748b',
                              cursor: 'pointer', transition: 'all 0.1s',
                            }}>
                            {t}
                          </button>
                        ))}
                      </div>
                    </Field>
                    <Field label="Data sensitivity">
                      <Select value={createMeta.dataSensitivity ?? 'INTERNAL'}
                        onChange={v => setCreateMeta(m => ({ ...m, dataSensitivity: v }))}
                        options={DATA_SENSITIVITY.map(d => ({ value: d, label: d }))} />
                    </Field>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <Field label="Expected SLA (hours)">
                      <input type="number" min={0} value={createMeta.slaHours ?? ''} placeholder="e.g. 24"
                        onChange={e => setCreateMeta(m => ({ ...m, slaHours: e.target.value ? Number(e.target.value) : undefined }))}
                        style={inputStyle} />
                    </Field>
                    <Field label="Flags">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: '#475569' }}>
                          <input type="checkbox" checked={!!createMeta.globallyAvailable}
                            onChange={e => setCreateMeta(m => ({ ...m, globallyAvailable: e.target.checked }))}
                            style={{ width: 15, height: 15, cursor: 'pointer' }} />
                          Available globally
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: '#475569' }}>
                          <input type="checkbox" checked={!!createMeta.requiresApprovalToRun}
                            onChange={e => setCreateMeta(m => ({ ...m, requiresApprovalToRun: e.target.checked }))}
                            style={{ width: 15, height: 15, cursor: 'pointer' }} />
                          Requires approval to run
                        </label>
                      </div>
                    </Field>
                  </div>
                </div>
              )}

              {/* ── STEP 3: Tags ────────────────────────────────────── */}
              {createStep === 'tags' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <Tag size={14} style={{ color: '#6366f1' }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#475569' }}>Custom key-value tags</span>
                  </div>
                  {(createMeta.tags ?? []).map((tag, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input value={tag.key} placeholder="key"
                        onChange={e => setCreateMeta(m => ({ ...m, tags: m.tags!.map((t, j) => j === i ? { ...t, key: e.target.value } : t) }))}
                        style={{ ...inputStyle, flex: 1 }} />
                      <span style={{ color: '#94a3b8', fontSize: 16, lineHeight: 1 }}>=</span>
                      <input value={tag.value} placeholder="value"
                        onChange={e => setCreateMeta(m => ({ ...m, tags: m.tags!.map((t, j) => j === i ? { ...t, value: e.target.value } : t) }))}
                        style={{ ...inputStyle, flex: 2 }} />
                      <button onClick={() => setCreateMeta(m => ({ ...m, tags: m.tags!.filter((_, j) => j !== i) }))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4 }}>
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  <button onClick={() => setCreateMeta(m => ({ ...m, tags: [...(m.tags ?? []), { key: '', value: '' }] }))}
                    style={{
                      padding: '7px 12px', borderRadius: 8, border: '1.5px dashed #cbd5e1',
                      background: 'transparent', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#64748b',
                      display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
                    }}>
                    <Plus size={13} /> Add tag
                  </button>
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '16px 28px', borderTop: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['identity', 'config', 'tags'] as const).map(s => (
                  <div key={s} style={{ width: 6, height: 6, borderRadius: '50%', background: createStep === s ? '#00843D' : '#e2e8f0' }} />
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {createStep !== 'identity' && (
                  <button onClick={() => setCreateStep(createStep === 'tags' ? 'config' : 'identity')}
                    style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e8f0', background: 'transparent', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#475569' }}>
                    Back
                  </button>
                )}
                <button onClick={() => { setCreateOpen(false); setCreateStep('identity') }}
                  style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: 'transparent', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#475569' }}>
                  Cancel
                </button>
                {createStep !== 'tags' ? (
                  <button onClick={() => setCreateStep(createStep === 'identity' ? 'config' : 'tags')}
                    disabled={createStep === 'identity' && !canAdvanceCreateIdentity}
                    style={{
                      padding: '8px 18px', borderRadius: 8, border: 'none', background: '#00843D',
                      color: '#fff', fontSize: 12, fontWeight: 700, cursor: createStep === 'identity' && !canAdvanceCreateIdentity ? 'not-allowed' : 'pointer',
                      opacity: createStep === 'identity' && !canAdvanceCreateIdentity ? 0.5 : 1,
                    }}>
                    Next →
                  </button>
                ) : (
                  <button
                    onClick={() => createWorkflowMut.mutate({ name: createName.trim(), description: createDesc, metadata: createMeta, capabilityId: createCapabilityId || undefined, teamId: createTeamId || undefined, starter: createStarter })}
                    disabled={createWorkflowMut.isPending || !createName.trim() || starterRequiresCapability}
                    style={{
                      padding: '8px 18px', borderRadius: 8, border: 'none', background: '#00843D',
                      color: '#fff', fontSize: 12, fontWeight: 700,
                      cursor: createWorkflowMut.isPending || starterRequiresCapability ? 'not-allowed' : 'pointer',
                      opacity: createWorkflowMut.isPending || starterRequiresCapability ? 0.7 : 1,
                    }}>
                    {createWorkflowMut.isPending ? 'Creating…' : 'Create Workflow'}
                  </button>
                )}
              </div>
            </div>
            {createWorkflowMut.isError && (
              <p style={{ fontSize: 11, color: '#dc2626', textAlign: 'center', padding: '0 28px 12px' }}>Failed to create workflow. Please try again.</p>
            )}
          </div>
        </div>
      )}

      {/* Import BPMN modal */}
      {importOpen && (
        <div
          onClick={() => setImportOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 200, backdropFilter: 'blur(4px)',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 16, padding: '28px',
              boxShadow: '0 24px 64px rgba(0,0,0,0.2)', maxWidth: 480, width: '100%',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, background: '#eef2ff',
                border: '1px solid #c7d2fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <FileCode size={18} style={{ color: '#6366f1' }} />
              </div>
              <div>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 2 }}>Import BPMN</p>
                <p style={{ fontSize: 12, color: '#64748b' }}>Paste your BPMN 2.0 XML below.</p>
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>
                Workflow name
              </label>
              <input
                value={importName}
                onChange={e => setImportName(e.target.value)}
                placeholder="My Workflow"
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '8px 12px',
                  borderRadius: 8, border: '1px solid var(--color-outline-variant)',
                  fontSize: 13, outline: 'none', fontFamily: 'inherit',
                }}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>
                BPMN XML
              </label>
              <textarea
                value={importXml}
                onChange={e => setImportXml(e.target.value)}
                rows={8}
                placeholder="<?xml version=&quot;1.0&quot; encoding=&quot;UTF-8&quot;?>&#10;<bpmn2:definitions …>"
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '8px 12px',
                  borderRadius: 8, border: '1px solid var(--color-outline-variant)',
                  fontSize: 11, fontFamily: 'monospace', outline: 'none', resize: 'vertical',
                }}
              />
            </div>

            {importBpmnMut.isError && (
              <p style={{ fontSize: 11, color: '#dc2626', marginBottom: 12 }}>Import failed — check the XML is valid BPMN 2.0.</p>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setImportOpen(false)}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-outline-variant)',
                  background: 'transparent', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#475569',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => importBpmnMut.mutate({ name: importName || 'Imported Workflow', xml: importXml })}
                disabled={importBpmnMut.isPending || !importXml.trim()}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none',
                  background: '#6366f1', color: '#fff', fontSize: 12, fontWeight: 700,
                  cursor: importBpmnMut.isPending ? 'not-allowed' : 'pointer',
                  opacity: importBpmnMut.isPending ? 0.7 : 1,
                }}
              >
                {importBpmnMut.isPending ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Duplicate workflow modal */}
      {duplicateOpen && (
        <div
          onClick={() => setDuplicateOpen(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 200, backdropFilter: 'blur(4px)',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 16, padding: '28px',
              boxShadow: '0 24px 64px rgba(0,0,0,0.2)', maxWidth: 420, width: '100%',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: 'rgba(56,189,248,0.10)', border: '1px solid rgba(56,189,248,0.18)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <GitBranch size={18} style={{ color: '#38bdf8' }} />
              </div>
              <div>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 2 }}>Duplicate workflow</p>
                <p style={{ fontSize: 12, color: '#64748b' }}>Create a copy with a new name or version.</p>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>
                New workflow name
              </label>
              <input
                autoFocus
                value={duplicateName}
                onChange={e => setDuplicateName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && duplicateName.trim() && duplicateOpen) {
                    duplicateTemplateMut.mutate({ sourceId: duplicateOpen.id, name: duplicateName.trim(), asNewVersion: duplicateAsNewVersion })
                  }
                  if (e.key === 'Escape') setDuplicateOpen(null)
                }}
                placeholder={duplicateOpen?.name ? `${duplicateOpen.name} (v2)` : 'Workflow name'}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '9px 12px',
                  borderRadius: 8, border: '1px solid var(--color-outline-variant)',
                  fontSize: 13, outline: 'none', fontFamily: 'inherit',
                }}
              />
            </div>

            <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--color-outline-variant)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={duplicateAsNewVersion}
                  onChange={e => setDuplicateAsNewVersion(e.target.checked)}
                  style={{ width: 16, height: 16, cursor: 'pointer' }}
                />
                <span style={{ fontSize: 13, fontWeight: 500, color: '#475569' }}>
                  Create as new version of "{duplicateOpen?.name}"
                </span>
              </label>
              <p style={{ fontSize: 11, color: '#64748b', margin: '6px 0 0 24px' }}>
                {duplicateAsNewVersion
                  ? 'A new version will be created under the same workflow'
                  : 'A completely separate workflow will be created'}
              </p>
            </div>

            {duplicateTemplateMut.isError && (
              <p style={{ fontSize: 11, color: '#dc2626', marginBottom: 12 }}>Failed to duplicate. Please try again.</p>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setDuplicateOpen(null)}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-outline-variant)',
                  background: 'transparent', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#475569',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => duplicateTemplateMut.mutate({ sourceId: duplicateOpen!.id, name: duplicateName.trim(), asNewVersion: duplicateAsNewVersion })}
                disabled={duplicateTemplateMut.isPending || !duplicateName.trim()}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none',
                  background: '#38bdf8', color: '#fff', fontSize: 12, fontWeight: 700,
                  cursor: duplicateTemplateMut.isPending ? 'not-allowed' : 'pointer',
                  opacity: (duplicateTemplateMut.isPending || !duplicateName.trim()) ? 0.6 : 1,
                }}
              >
                {duplicateTemplateMut.isPending ? 'Duplicating…' : 'Duplicate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import JSON modal */}
      {importJsonOpen && (
        <div
          onClick={() => setImportJsonOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 200, backdropFilter: 'blur(4px)',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 16, padding: '28px',
              boxShadow: '0 24px 64px rgba(0,0,0,0.2)', maxWidth: 520, width: '100%',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, background: '#f0fdf4',
                border: '1px solid #bbf7d0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <Upload size={18} style={{ color: '#16a34a' }} />
              </div>
              <div>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 2 }}>Import JSON</p>
                <p style={{ fontSize: 12, color: '#64748b' }}>Upload or paste a workflow JSON export file.</p>
              </div>
              <button
                onClick={() => setImportJsonOpen(false)}
                style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4 }}
              >
                <X size={16} />
              </button>
            </div>

            {/* File picker */}
            <div style={{ marginBottom: 12 }}>
              <input
                ref={importJsonFileRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const reader = new FileReader()
                  reader.onload = ev => setImportJsonText(ev.target?.result as string ?? '')
                  reader.readAsText(file)
                  e.target.value = ''
                }}
              />
              <button
                onClick={() => importJsonFileRef.current?.click()}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                  padding: '7px 14px', borderRadius: 8, border: '1px dashed #cbd5e1',
                  background: '#f8fafc', cursor: 'pointer', color: '#475569', fontWeight: 600, width: '100%',
                  justifyContent: 'center',
                }}
              >
                <Upload size={13} /> Choose file…
              </button>
            </div>

            <p style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', margin: '0 0 10px' }}>— or paste JSON below —</p>

            <div style={{ marginBottom: 20 }}>
              <textarea
                value={importJsonText}
                onChange={e => setImportJsonText(e.target.value)}
                rows={10}
                placeholder={'{\n  "_exportVersion": 2,\n  "template": { "name": "My Workflow" },\n  "latestGraphSnapshot": { ... }\n}'}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '8px 12px',
                  borderRadius: 8, border: '1px solid var(--color-outline-variant)',
                  fontSize: 11, fontFamily: 'monospace', outline: 'none', resize: 'vertical',
                }}
              />
            </div>

            {importJsonMut.isError && (
              <p style={{ fontSize: 11, color: '#dc2626', marginBottom: 12 }}>
                Import failed — make sure the JSON is a valid workflow export.
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setImportJsonOpen(false); setImportJsonText('') }}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-outline-variant)',
                  background: 'transparent', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#475569',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  try {
                    const doc = JSON.parse(importJsonText)
                    importJsonMut.mutate(doc)
                  } catch {
                    importJsonMut.reset()
                  }
                }}
                disabled={importJsonMut.isPending || !importJsonText.trim()}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none',
                  background: '#16a34a', color: '#fff', fontSize: 12, fontWeight: 700,
                  cursor: (importJsonMut.isPending || !importJsonText.trim()) ? 'not-allowed' : 'pointer',
                  opacity: (importJsonMut.isPending || !importJsonText.trim()) ? 0.7 : 1,
                }}
              >
                {importJsonMut.isPending ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── RunModal — name + INPUT vars + per-phase assignment pickers ─────────────

// Extract {{vars.X}} tokens from a string value.
function extractVarRefs(val: unknown): string[] {
  if (typeof val !== 'string') return []
  const hits: string[] = []
  const re = /\{\{\s*vars\.([^}\s]+)\s*\}\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(val)) !== null) hits.push(m[1])
  return hits
}

// Assignment field key per mode → what type of value it holds
const ASSIGNMENT_VAR_KIND: Record<string, 'team' | 'user' | 'role' | 'skill'> = {
  assignedToId: 'user',
  teamId:       'team',
  roleKey:      'role',
  skillKey:     'skill',
}

function mutationErrorMessage(error: unknown): string | null {
  if (!error) return null
  if (typeof error === 'object' && error && 'response' in error) {
    const data = (error as { response?: { data?: unknown } }).response?.data
    if (typeof data === 'string') return data
    if (data && typeof data === 'object') {
      const message = (data as { message?: unknown; error?: unknown }).message ?? (data as { message?: unknown; error?: unknown }).error
      if (typeof message === 'string') return message
    }
  }
  if (error instanceof Error) return error.message
  return 'Could not start this workflow run.'
}

function RunModal({
  workflow, submitting, error, onCancel, onSubmit, onSubmitBrowser,
}: {
  workflow:   WorkflowTemplate
  submitting: boolean
  error?:     unknown
  onCancel:   () => void
  onSubmit:   (body: { name?: string; vars?: Record<string, unknown>; globals?: Record<string, unknown> }) => void
  onSubmitBrowser: (body: { name?: string; vars?: Record<string, unknown>; globals?: Record<string, unknown> }) => void
}) {
  const inputVars = (workflow.variables ?? []).filter(v => (v.scope ?? 'INPUT') === 'INPUT')
  const inputVarKeys = new Set(inputVars.map(v => v.key))

  const [name, setName] = useState(() => {
    const d = new Date()
    const stamp = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
    return `${workflow.name} · Run · ${stamp}`
  })
  const [varsState, setVars] = useState<Record<string, unknown>>(() => {
    const seed: Record<string, unknown> = {}
    for (const v of inputVars) if (v.defaultValue !== undefined) seed[v.key] = v.defaultValue
    return seed
  })
  const [globalsState, setGlobals] = useState<Record<string, unknown>>({})

  // ── Fetch design graph to discover assignment inputs per phase ────────────
  const { data: designGraph } = useQuery({
    queryKey: ['design-graph', workflow.id],
    queryFn: () => api.get(`/workflow-templates/${workflow.id}/design-graph`).then(r => r.data as {
      phases: Array<{ id: string; name: string; displayOrder: number }>
      nodes:  Array<{ id: string; label: string; nodeType: string; phaseId?: string; config?: Record<string, unknown> }>
    }),
    staleTime: 60_000,
  })

  // ── Fetch teams and users for smart pickers ───────────────────────────────
  const { data: teamsData } = useQuery({
    queryKey: ['teams-list'],
    queryFn: () => api.get('/teams').then(r => {
      const d = r.data
      return (Array.isArray(d) ? d : (d?.content ?? [])) as Array<{ id: string; name: string }>
    }),
    staleTime: 60_000,
  })
  const { data: usersData } = useQuery({
    queryKey: ['users-list'],
    queryFn: () => api.get('/users?size=200').then(r => r.data?.content ?? []) as Promise<Array<{ id: string; email: string; displayName?: string }>>,
    staleTime: 60_000,
  })
  const teams = teamsData ?? []
  const users = usersData ?? []

  // ── Build per-phase assignment requirements ───────────────────────────────
  // For each node that uses {{vars.X}} in an assignment field, and X is NOT
  // already an INPUT-scoped workflow variable, we surface it as a picker.
  type AssignmentReq = {
    varKey:    string
    kind:      'team' | 'user' | 'role' | 'skill'
    nodeLabel: string
    nodeType:  string
    phaseName: string
    phaseOrder: number
  }

  const assignmentReqs: AssignmentReq[] = []
  const seenVarKeys = new Set<string>()

  if (designGraph) {
    const phaseMap = new Map(designGraph.phases.map(p => [p.id, p]))
    const humanNodes = designGraph.nodes.filter(n =>
      ['HUMAN_TASK', 'APPROVAL', 'CONSUMABLE_CREATION'].includes(n.nodeType)
    )
    for (const n of humanNodes) {
      const cfg = n.config ?? {}
      const phase = n.phaseId ? phaseMap.get(n.phaseId) : undefined
      for (const [fieldKey, kind] of Object.entries(ASSIGNMENT_VAR_KIND)) {
        const refs = extractVarRefs(cfg[fieldKey])
        for (const varKey of refs) {
          if (inputVarKeys.has(varKey)) continue  // already shown above
          if (seenVarKeys.has(varKey)) continue   // deduped across nodes
          seenVarKeys.add(varKey)
          assignmentReqs.push({
            varKey, kind,
            nodeLabel:  n.label || n.nodeType,
            nodeType:   n.nodeType,
            phaseName:  phase?.name ?? 'Unphased',
            phaseOrder: phase?.displayOrder ?? 999,
          })
        }
      }
    }
    // Sort by phase display order
    assignmentReqs.sort((a, b) => a.phaseOrder - b.phaseOrder)
  }

  // Group assignment requirements by phase
  const byPhase = new Map<string, AssignmentReq[]>()
  for (const req of assignmentReqs) {
    if (!byPhase.has(req.phaseName)) byPhase.set(req.phaseName, [])
    byPhase.get(req.phaseName)!.push(req)
  }

  const setVar = (k: string, v: unknown) => setVars(prev => ({ ...prev, [k]: v }))

  const buildBody = () => {
    const body: { name?: string; vars?: Record<string, unknown>; globals?: Record<string, unknown> } = {}
    if (name.trim()) body.name = name.trim()
    if (Object.keys(varsState).length    > 0) body.vars    = varsState
    if (Object.keys(globalsState).length > 0) body.globals = globalsState
    return body
  }
  const submit        = () => onSubmit(buildBody())
  const submitBrowser = () => onSubmitBrowser(buildBody())
  const errorMessage = mutationErrorMessage(error)

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(2,6,23,0.45)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 560, maxHeight: '88vh', overflowY: 'auto',
          padding: 22, borderRadius: 14, background: '#fff',
          boxShadow: '0 18px 48px rgba(2,6,23,0.18)',
          border: '1px solid var(--color-outline-variant)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
          <Play size={15} style={{ color: 'var(--color-primary)' }} />
          <h3 style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-on-surface)', margin: 0 }}>
            Start a run
          </h3>
        </div>
        <p style={{ fontSize: 12, color: 'var(--color-outline)', marginBottom: 16 }}>
          {workflow.name}
        </p>

        {/* ── Run name ── */}
        <div style={{ marginBottom: 14 }}>
          <label style={modalLabelStyle}>Run name *</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Onboarding · Acme · Q4"
            style={modalInputStyle}
            autoFocus
          />
          <p style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 4 }}>
            Shown in the Runs list and inbox so people can tell parallel runs apart.
          </p>
        </div>

        {/* ── Workflow INPUT variables ── */}
        {inputVars.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <label style={modalLabelStyle}>Workflow inputs ({inputVars.length})</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {inputVars.map(v => (
                <VarInput key={v.key} v={v} value={varsState[v.key]} onChange={val => setVar(v.key, val)} />
              ))}
            </div>
          </div>
        )}

        {/* ── Per-phase assignment pickers ── */}
        {byPhase.size > 0 && (
          <div style={{ marginBottom: 14 }}>
            <label style={modalLabelStyle}>Assignment details</label>
            <p style={{ fontSize: 11, color: 'var(--color-outline)', marginBottom: 8 }}>
              These nodes need to know who handles them. Select the team, user, or role for each phase.
            </p>
            {Array.from(byPhase.entries()).map(([phaseName, reqs]) => (
              <div key={phaseName} style={{ marginBottom: 10 }}>
                {/* Phase header */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  marginBottom: 6, paddingBottom: 4,
                  borderBottom: '1px solid var(--color-outline-variant)',
                }}>
                  <span style={{
                    fontSize: 9, fontWeight: 800, textTransform: 'uppercase',
                    letterSpacing: '0.14em', color: 'var(--color-primary)',
                  }}>
                    {phaseName}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {reqs.map(req => (
                    <AssignmentPicker
                      key={req.varKey}
                      req={req}
                      value={varsState[req.varKey]}
                      teams={teams}
                      users={users}
                      onChange={val => setVar(req.varKey, val)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Optional globals overrides ── */}
        <details style={{ marginBottom: 14 }}>
          <summary style={{ ...modalLabelStyle, cursor: 'pointer', listStyle: 'none' }}>
            Override per-instance globals (optional)
          </summary>
          <p style={{ fontSize: 10, color: 'var(--color-outline)', marginTop: 6, marginBottom: 6 }}>
            Override INSTANCE-scoped team globals for this run only.
          </p>
          <FreeformKVEditor entries={globalsState} onChange={setGlobals} />
        </details>

        {errorMessage && (
          <p style={{
            margin: '0 0 12px',
            padding: '9px 10px',
            borderRadius: 8,
            border: '1px solid rgba(220,38,38,0.22)',
            background: 'rgba(220,38,38,0.06)',
            color: '#b91c1c',
            fontSize: 12,
            lineHeight: 1.4,
          }}>
            {errorMessage}
          </p>
        )}

        {/* ── Footer ── */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button
            onClick={onCancel}
            disabled={submitting}
            style={{
              padding: '8px 14px', borderRadius: 8,
              border: '1px solid var(--color-outline-variant)', background: '#fff',
              color: 'var(--color-on-surface)', fontSize: 12, fontWeight: 600,
              cursor: submitting ? 'default' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !name.trim()}
            title="Server-side run: persisted via the backend engine; participates in the Inbox + queue routing."
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '8px 14px', borderRadius: 8,
              border: '1px solid var(--color-outline-variant)',
              background: '#fff', color: 'var(--color-on-surface)',
              fontSize: 12, fontWeight: 700,
              cursor: (submitting || !name.trim()) ? 'default' : 'pointer',
              opacity: (submitting || !name.trim()) ? 0.6 : 1,
            }}
          >
            <Play size={11} /> {submitting ? 'Starting…' : 'Server run'}
          </button>
          <button
            onClick={submitBrowser}
            disabled={!name.trim()}
            title="Browser run: runs entirely in this browser; instant feedback, single-user."
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '8px 14px', borderRadius: 8, border: 'none',
              background: 'var(--color-primary)', color: '#fff',
              fontSize: 12, fontWeight: 700,
              cursor: !name.trim() ? 'default' : 'pointer',
              opacity: !name.trim() ? 0.6 : 1,
            }}
          >
            <Play size={11} /> Run in browser
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Workflow variable input (type-aware) ──────────────────────────────────────

function VarInput({ v, value, onChange }: {
  v: TemplateVariableDef
  value: unknown
  onChange: (val: unknown) => void
}) {
  return (
    <div style={{
      padding: '9px 11px', borderRadius: 8,
      border: '1px solid var(--color-outline-variant)', background: '#fafafa',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-on-surface)' }}>
        {v.label ?? v.key}{' '}
        <code style={{ fontFamily: 'monospace', fontWeight: 500, color: 'var(--color-outline)' }}>
          vars.{v.key}
        </code>
      </div>
      {v.description && (
        <p style={{ fontSize: 10, color: 'var(--color-outline)', marginTop: 2 }}>{v.description}</p>
      )}
      {v.type === 'BOOLEAN' ? (
        <select
          value={String(value === true)}
          onChange={e => onChange(e.target.value === 'true')}
          style={{ ...modalInputStyle, marginTop: 5, cursor: 'pointer' }}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : v.type === 'JSON' ? (
        <textarea
          value={typeof value === 'string' ? value : JSON.stringify(value ?? '')}
          onChange={e => {
            try { onChange(JSON.parse(e.target.value)) } catch { onChange(e.target.value) }
          }}
          rows={2}
          placeholder='{"foo": 1}'
          style={{ ...modalInputStyle, marginTop: 5, fontFamily: 'monospace', resize: 'vertical' }}
        />
      ) : (
        <input
          type={v.type === 'NUMBER' ? 'number' : 'text'}
          value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
          onChange={e => {
            if (v.type === 'NUMBER') {
              const n = Number(e.target.value)
              onChange(Number.isNaN(n) ? e.target.value : n)
            } else onChange(e.target.value)
          }}
          placeholder={v.defaultValue !== undefined ? String(v.defaultValue) : ''}
          style={{ ...modalInputStyle, marginTop: 5 }}
        />
      )}
    </div>
  )
}

// ── Assignment picker (team / user / role / skill) ────────────────────────────

const KIND_META = {
  team:  { label: 'Team',  color: '#0ea5e9', hint: 'Select the team that will handle this stage' },
  user:  { label: 'User',  color: '#22c55e', hint: 'Select the person directly assigned' },
  role:  { label: 'Role',  color: '#a855f7', hint: 'Enter the role key (anyone with this role can claim)' },
  skill: { label: 'Skill', color: '#f97316', hint: 'Enter the skill key (anyone with this skill can claim)' },
}

function AssignmentPicker({ req, value, teams, users, onChange }: {
  req:    { varKey: string; kind: 'team' | 'user' | 'role' | 'skill'; nodeLabel: string; nodeType: string }
  value:  unknown
  teams:  Array<{ id: string; name: string }>
  users:  Array<{ id: string; email: string; displayName?: string }>
  onChange: (val: unknown) => void
}) {
  const meta = KIND_META[req.kind]
  const strVal = typeof value === 'string' ? value : ''

  return (
    <div style={{
      padding: '9px 11px', borderRadius: 8,
      border: `1px solid rgba(${req.kind === 'team' ? '14,165,233' : req.kind === 'user' ? '34,197,94' : req.kind === 'role' ? '168,85,247' : '249,115,22'}, 0.25)`,
      background: '#fafafa',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{
          fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em',
          padding: '1px 6px', borderRadius: 4,
          background: `rgba(${req.kind === 'team' ? '14,165,233' : req.kind === 'user' ? '34,197,94' : req.kind === 'role' ? '168,85,247' : '249,115,22'}, 0.12)`,
          color: meta.color,
        }}>
          {meta.label}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-on-surface)' }}>
          {req.nodeLabel}
        </span>
        <code style={{ fontSize: 10, color: 'var(--color-outline)', fontFamily: 'monospace' }}>
          vars.{req.varKey}
        </code>
      </div>
      <p style={{ fontSize: 10, color: 'var(--color-outline)', marginBottom: 5 }}>{meta.hint}</p>

      {req.kind === 'team' && teams.length > 0 ? (
        <select
          value={strVal}
          onChange={e => onChange(e.target.value)}
          style={{ ...modalInputStyle, cursor: 'pointer' }}
        >
          <option value="">Select a team…</option>
          {teams.map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      ) : req.kind === 'user' && users.length > 0 ? (
        <select
          value={strVal}
          onChange={e => onChange(e.target.value)}
          style={{ ...modalInputStyle, cursor: 'pointer' }}
        >
          <option value="">Select a user…</option>
          {users.map(u => (
            <option key={u.id} value={u.id}>{u.displayName ?? u.email}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={strVal}
          onChange={e => onChange(e.target.value)}
          placeholder={req.kind === 'role' ? 'reviewer' : req.kind === 'skill' ? 'react' : ''}
          style={modalInputStyle}
        />
      )}
    </div>
  )
}

function FreeformKVEditor({
  entries, onChange,
}: {
  entries:  Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  const keys = Object.keys(entries)
  const set = (k: string, v: unknown) => onChange({ ...entries, [k]: v })
  const rename = (oldKey: string, newKey: string) => {
    if (oldKey === newKey) return
    const next: Record<string, unknown> = {}
    for (const k of keys) next[k === oldKey ? newKey : k] = entries[k]
    onChange(next)
  }
  const remove = (k: string) => {
    const next = { ...entries }
    delete next[k]
    onChange(next)
  }
  const add = () => {
    let i = 1
    while (entries[`key${i}`] !== undefined) i++
    onChange({ ...entries, [`key${i}`]: '' })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {keys.map(k => (
        <div key={k} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 28px', gap: 6 }}>
          <input
            value={k}
            onChange={e => rename(k, e.target.value)}
            placeholder="globals.key"
            style={{ ...modalInputStyle, fontFamily: 'monospace' }}
          />
          <input
            value={String(entries[k] ?? '')}
            onChange={e => set(k, e.target.value)}
            placeholder="value"
            style={modalInputStyle}
          />
          <button
            onClick={() => remove(k)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        onClick={add}
        style={{
          marginTop: 4, padding: '5px 10px', borderRadius: 6,
          border: '1px dashed var(--color-outline-variant)',
          background: 'transparent', cursor: 'pointer',
          fontSize: 11, fontWeight: 600, color: 'var(--color-outline)',
          alignSelf: 'flex-start',
        }}
      >
        + Add override
      </button>
    </div>
  )
}

const modalLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: '#475569', marginBottom: 5,
}
const modalInputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 7,
  border: '1px solid var(--color-outline-variant)', fontSize: 12,
  outline: 'none', fontFamily: 'inherit', color: 'var(--color-on-surface)',
}
