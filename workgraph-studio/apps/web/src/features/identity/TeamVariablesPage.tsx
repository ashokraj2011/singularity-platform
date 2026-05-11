import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import {
  Plus, Edit2, Trash2, Save, X, Globe, AlertCircle, Hash, Type, ToggleLeft, Braces, Layers,
} from 'lucide-react'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth.store'
import type { VarType, VarScope } from '../variables/types'

// ─── Types ────────────────────────────────────────────────────────────────────

type Visibility = 'ORG_GLOBAL' | 'CAPABILITY' | 'WORKFLOW'
type EditableBy = 'USER' | 'SYSTEM'

type TeamVariable = {
  id:          string
  teamId:      string
  key:         string
  label?:      string
  type:        VarType
  scope:       VarScope
  visibility:  Visibility
  visibilityScopeId?: string | null
  editableBy:  EditableBy
  value:       unknown
  description?: string
  createdAt:   string
  updatedAt:   string
}

type Team = { id: string; name: string }

const TYPE_ICON: Record<VarType, React.ElementType> = {
  STRING:  Type,
  NUMBER:  Hash,
  BOOLEAN: ToggleLeft,
  JSON:    Braces,
}

const TYPE_COLOR: Record<VarType, string> = {
  STRING:  '#38bdf8',
  NUMBER:  '#a78bfa',
  BOOLEAN: '#f59e0b',
  JSON:    '#10b981',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderValue(v: unknown, type: VarType): string {
  if (v === undefined || v === null) return '—'
  if (type === 'JSON') return JSON.stringify(v)
  if (type === 'BOOLEAN') return v ? 'true' : 'false'
  return String(v)
}

function parseInputValue(raw: string, type: VarType): unknown {
  if (type === 'NUMBER') {
    const n = Number(raw)
    if (Number.isNaN(n)) throw new Error('Not a number')
    return n
  }
  if (type === 'BOOLEAN') return raw === 'true' || raw === '1'
  if (type === 'JSON')    return JSON.parse(raw)
  return raw
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function TeamVariablesPage() {
  const qc = useQueryClient()
  const user = useAuthStore(s => s.user)
  const ADMIN_ROLE_NAMES = ['ADMIN', 'admin', 'Admin', 'SYSTEM_ADMIN', 'SystemAdmin', 'WORKFLOW_ADMIN', 'WorkflowAdmin']
  const isAdmin = (user?.roles ?? []).some(r => ADMIN_ROLE_NAMES.includes(r))
  const [selectedTeamId, setSelectedTeamId] = useState<string>(user?.teamId ?? '')

  // /api/teams returns { content: [...] }; older code expected { data } or
  // bare array. Accept all three shapes so the picker populates either way.
  const { data: teamsResp } = useQuery<{ content?: Team[]; data?: Team[] } | Team[]>({
    queryKey: ['teams', 'list'],
    queryFn: () => api.get('/teams').then(r => r.data),
  })
  const teams: Team[] = Array.isArray(teamsResp)
    ? teamsResp
    : Array.isArray((teamsResp as any)?.content) ? (teamsResp as any).content
    : Array.isArray((teamsResp as any)?.data)    ? (teamsResp as any).data
    : []

  // Default selected team to current user's team if it exists in the list
  if (!selectedTeamId && teams.length > 0) {
    setSelectedTeamId(user?.teamId && teams.find(t => t.id === user.teamId) ? user.teamId : teams[0].id)
  }

  const { data: vars = [], isLoading } = useQuery<TeamVariable[]>({
    queryKey: ['team-variables', selectedTeamId],
    queryFn: () => api.get(`/teams/${selectedTeamId}/variables`).then(r => r.data),
    enabled: !!selectedTeamId,
  })

  const createMut = useMutation({
    mutationFn: (body: Partial<TeamVariable>) =>
      api.post(`/teams/${selectedTeamId}/variables`, body).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-variables', selectedTeamId] }),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, ...body }: Partial<TeamVariable> & { id: string }) =>
      api.patch(`/teams/${selectedTeamId}/variables/${id}`, body).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-variables', selectedTeamId] }),
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/teams/${selectedTeamId}/variables/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-variables', selectedTeamId] }),
  })

  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: 'rgba(56,189,248,0.12)', border: '1px solid rgba(56,189,248,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0284c7',
        }}>
          <Globe size={18} />
        </div>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-on-surface)', margin: 0 }}>Global Variables</h1>
          <p style={{ fontSize: 12, color: 'var(--color-outline)', margin: 0 }}>
            Constants referenced as <code style={{ fontFamily: 'monospace', background: 'rgba(0,0,0,0.04)', padding: '1px 4px', borderRadius: 3 }}>globals.key</code>. Visibility decides which workflows see them; SYSTEM-tagged ones are admin-only.
          </p>
        </div>
      </div>

      {/* Team selector + Add */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, marginBottom: 14 }}>
        <select
          value={selectedTeamId}
          onChange={e => setSelectedTeamId(e.target.value)}
          style={{
            padding: '7px 10px', borderRadius: 8, border: '1px solid var(--color-outline-variant)',
            background: '#fff', fontSize: 12, fontWeight: 600, color: 'var(--color-on-surface)', cursor: 'pointer',
          }}
        >
          {teams.length === 0 && <option value="">— No teams —</option>}
          {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <button
          disabled={!selectedTeamId}
          onClick={() => { setCreating(true); setEditingId(null) }}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 14px', borderRadius: 8, border: 'none',
            background: 'var(--color-primary)', color: '#fff', fontSize: 12, fontWeight: 700,
            cursor: !selectedTeamId ? 'default' : 'pointer', opacity: !selectedTeamId ? 0.5 : 1,
          }}
        >
          <Plus size={13} /> New variable
        </button>
      </div>

      {/* Create form */}
      <AnimatePresence>
        {creating && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{ overflow: 'hidden', marginBottom: 14 }}
          >
            <VariableForm
              isAdmin={isAdmin}
              onSubmit={async body => {
                await createMut.mutateAsync(body)
                setCreating(false)
              }}
              onCancel={() => setCreating(false)}
              saving={createMut.isPending}
              error={(createMut.error as any)?.response?.data?.error}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* List */}
      {isLoading ? (
        <p style={{ fontSize: 12, color: 'var(--color-outline)' }}>Loading…</p>
      ) : vars.length === 0 ? (
        <div style={{
          padding: '36px 20px', textAlign: 'center', borderRadius: 10,
          border: '1px dashed var(--color-outline-variant)', background: '#fafafa',
        }}>
          <p style={{ fontSize: 13, color: 'var(--color-on-surface)', fontWeight: 600, marginBottom: 6 }}>
            No variables yet
          </p>
          <p style={{ fontSize: 11, color: 'var(--color-outline)', marginBottom: 14 }}>
            Add team-wide constants like company name, default approver, or environment URL.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {vars.map(v => {
            const Icon  = TYPE_ICON[v.type]
            const color = TYPE_COLOR[v.type]
            const isEditing = editingId === v.id
            return (
              <div key={v.id} style={{
                padding: '11px 14px', borderRadius: 10,
                border: '1px solid var(--color-outline-variant)', background: '#fff',
              }}>
                {isEditing ? (
                  <VariableForm
                    initial={v}
                    isAdmin={isAdmin}
                    onSubmit={async body => {
                      await updateMut.mutateAsync({ id: v.id, ...body })
                      setEditingId(null)
                    }}
                    onCancel={() => setEditingId(null)}
                    saving={updateMut.isPending}
                    error={(updateMut.error as any)?.response?.data?.error}
                  />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 30, height: 30, borderRadius: 8,
                      background: `${color}15`, border: `1px solid ${color}30`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color, flexShrink: 0,
                    }}>
                      <Icon size={14} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <code style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: 'var(--color-on-surface)' }}>globals.{v.key}</code>
                        {v.label && <span style={{ fontSize: 11, color: 'var(--color-outline)' }}>· {v.label}</span>}
                        <span style={{ fontSize: 9, fontWeight: 700, color, background: `${color}10`, padding: '2px 6px', borderRadius: 4, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{v.type}</span>
                        {v.scope === 'INSTANCE' ? (
                          <span title="Each running instance can override this value" style={{ fontSize: 9, fontWeight: 700, color: '#a855f7', background: 'rgba(168,85,247,0.10)', padding: '2px 6px', borderRadius: 4, letterSpacing: '0.08em', textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <Layers size={9} /> per-instance
                          </span>
                        ) : (
                          <span title="Same value across every workflow instance" style={{ fontSize: 9, fontWeight: 700, color: '#0ea5e9', background: 'rgba(14,165,233,0.10)', padding: '2px 6px', borderRadius: 4, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                            global
                          </span>
                        )}
                        <span title={
                          v.visibility === 'ORG_GLOBAL' ? 'Visible to every workflow' :
                          v.visibility === 'CAPABILITY' ? `Visible only under capability ${v.visibilityScopeId ?? '(unset)'}` :
                                                          `Visible only in workflow ${v.visibilityScopeId ?? '(unset)'}`
                        } style={{
                          fontSize: 9, fontWeight: 700,
                          color:      v.visibility === 'ORG_GLOBAL' ? '#22c55e' : v.visibility === 'CAPABILITY' ? '#a855f7' : '#0ea5e9',
                          background: v.visibility === 'ORG_GLOBAL' ? 'rgba(34,197,94,0.10)' : v.visibility === 'CAPABILITY' ? 'rgba(168,85,247,0.10)' : 'rgba(14,165,233,0.10)',
                          padding: '2px 6px', borderRadius: 4, letterSpacing: '0.08em', textTransform: 'uppercase',
                        }}>
                          {v.visibility === 'ORG_GLOBAL' ? 'visible: org' : v.visibility === 'CAPABILITY' ? 'visible: capability' : 'visible: workflow'}
                        </span>
                        {v.editableBy === 'SYSTEM' && (
                          <span title="Only admins / system processes can edit this variable" style={{
                            fontSize: 9, fontWeight: 700, color: '#d97706',
                            background: 'rgba(245,158,11,0.12)',
                            padding: '2px 6px', borderRadius: 4, letterSpacing: '0.08em', textTransform: 'uppercase',
                          }}>
                            system
                          </span>
                        )}
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 2, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {v.scope === 'INSTANCE' ? 'default: ' : ''}{renderValue(v.value, v.type)}
                      </p>
                      {v.description && (
                        <p style={{ fontSize: 10, color: '#94a3b8', marginTop: 3 }}>{v.description}</p>
                      )}
                    </div>
                    <button
                      onClick={() => { setEditingId(v.id); setCreating(false) }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-outline)', padding: 6 }}
                    >
                      <Edit2 size={13} />
                    </button>
                    <button
                      onClick={() => { if (confirm(`Delete variable "${v.key}"?`)) deleteMut.mutate(v.id) }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 6 }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Variable form (create + edit) ───────────────────────────────────────────

function VariableForm({
  initial, onSubmit, onCancel, saving, error, isAdmin,
}: {
  initial?: TeamVariable
  onSubmit: (body: { key: string; label?: string; type: VarType; scope: VarScope; visibility: Visibility; visibilityScopeId?: string | null; editableBy: EditableBy; value: unknown; description?: string }) => void
  onCancel: () => void
  saving: boolean
  error?: string
  isAdmin: boolean
}) {
  const [key,         setKey]         = useState(initial?.key ?? '')
  const [label,       setLabel]       = useState(initial?.label ?? '')
  const [type,        setType]        = useState<VarType>(initial?.type ?? 'STRING')
  const [scope,       setScope]       = useState<VarScope>(initial?.scope ?? 'GLOBAL')
  const [visibility,  setVisibility]  = useState<Visibility>(initial?.visibility ?? 'ORG_GLOBAL')
  const [visibilityScopeId, setVisibilityScopeId] = useState<string>(initial?.visibilityScopeId ?? '')
  const [editableBy,  setEditableBy]  = useState<EditableBy>(initial?.editableBy ?? 'USER')
  const [valueRaw,    setValueRaw]    = useState(() => initial ? renderValue(initial.value, initial.type) : '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [parseError,  setParseError]  = useState<string | null>(null)

  // SYSTEM-tagged rows are read-only for non-admins.
  const lockedAsSystem = !!initial && initial.editableBy === 'SYSTEM' && !isAdmin

  const handleSubmit = () => {
    setParseError(null)
    if (visibility !== 'ORG_GLOBAL' && !visibilityScopeId.trim()) {
      setParseError('Visibility scope id is required when visibility is CAPABILITY or WORKFLOW.')
      return
    }
    try {
      const value = parseInputValue(valueRaw, type)
      onSubmit({
        key, label: label || undefined, type, scope,
        visibility,
        visibilityScopeId: visibility === 'ORG_GLOBAL' ? null : visibilityScopeId.trim(),
        editableBy,
        value, description: description || undefined,
      })
    } catch (err: any) {
      setParseError(err?.message ?? 'Invalid value for this type')
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 7,
    border: '1px solid var(--color-outline-variant)', fontSize: 12,
    outline: 'none', fontFamily: 'inherit', color: 'var(--color-on-surface)',
  }

  return (
    <div style={{ padding: 14, borderRadius: 10, background: '#fafafa', border: '1px solid var(--color-outline-variant)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px', gap: 10, marginBottom: 10 }}>
        <div>
          <label style={{ fontSize: 9, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 4 }}>Key *</label>
          <input value={key} onChange={e => setKey(e.target.value)} disabled={!!initial} placeholder="company_name" style={{ ...inputStyle, fontFamily: 'monospace' }} />
        </div>
        <div>
          <label style={{ fontSize: 9, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 4 }}>Label</label>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Company Name" style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 9, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 4 }}>Type</label>
          <select value={type} onChange={e => setType(e.target.value as VarType)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {(['STRING', 'NUMBER', 'BOOLEAN', 'JSON'] as const).map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      {/* Scope picker — GLOBAL vs INSTANCE */}
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 9, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>Scope</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
          {([
            { v: 'GLOBAL',   label: 'Global',       desc: 'Same fixed value across every workflow instance.', color: '#0ea5e9' },
            { v: 'INSTANCE', label: 'Per-instance', desc: 'Each running instance gets its own value (defaulted to the value below).', color: '#a855f7' },
          ] as const).map(opt => (
            <button
              key={opt.v}
              onClick={() => setScope(opt.v as VarScope)}
              style={{
                textAlign: 'left',
                padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
                border: `1.5px solid ${scope === opt.v ? opt.color : 'var(--color-outline-variant)'}`,
                background: scope === opt.v ? `${opt.color}10` : 'transparent',
              }}
            >
              <p style={{ fontSize: 11, fontWeight: 700, color: scope === opt.v ? opt.color : 'var(--color-on-surface)', margin: 0 }}>{opt.label}</p>
              <p style={{ fontSize: 10, color: 'var(--color-outline)', marginTop: 3, lineHeight: 1.4 }}>{opt.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Visibility — who can SEE this variable */}
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 9, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>Visibility</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 7 }}>
          {([
            { v: 'ORG_GLOBAL', label: 'Global',     desc: 'Visible to every workflow in every team.',                        color: '#22c55e' },
            { v: 'CAPABILITY', label: 'Capability', desc: 'Visible only to workflows under one capability.',                  color: '#a855f7' },
            { v: 'WORKFLOW',   label: 'Workflow',   desc: 'Visible only to one specific workflow.',                           color: '#0ea5e9' },
          ] as const).map(opt => (
            <button
              key={opt.v}
              onClick={() => setVisibility(opt.v as Visibility)}
              disabled={lockedAsSystem}
              style={{
                textAlign: 'left',
                padding: '7px 10px', borderRadius: 8, cursor: lockedAsSystem ? 'default' : 'pointer',
                border: `1.5px solid ${visibility === opt.v ? opt.color : 'var(--color-outline-variant)'}`,
                background: visibility === opt.v ? `${opt.color}10` : 'transparent',
                opacity: lockedAsSystem ? 0.6 : 1,
              }}
            >
              <p style={{ fontSize: 11, fontWeight: 700, color: visibility === opt.v ? opt.color : 'var(--color-on-surface)', margin: 0 }}>{opt.label}</p>
              <p style={{ fontSize: 10, color: 'var(--color-outline)', marginTop: 3, lineHeight: 1.4 }}>{opt.desc}</p>
            </button>
          ))}
        </div>
        {visibility !== 'ORG_GLOBAL' && (
          <input
            value={visibilityScopeId}
            onChange={e => setVisibilityScopeId(e.target.value)}
            disabled={lockedAsSystem}
            placeholder={visibility === 'CAPABILITY' ? 'Capability id (from IAM)' : 'Workflow id'}
            style={{ ...inputStyle, marginTop: 7, fontFamily: 'monospace' }}
          />
        )}
      </div>

      {/* Editable-by — who can WRITE this variable */}
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 9, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>
          Editable by
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
          {([
            { v: 'USER',   label: 'Users',  desc: 'Any team member with the right role can edit this value.',                          color: '#22c55e' },
            { v: 'SYSTEM', label: 'System', desc: 'Only admins and automated system processes can edit. Not user-editable in the studio.', color: '#f59e0b' },
          ] as const).map(opt => (
            <button
              key={opt.v}
              onClick={() => setEditableBy(opt.v as EditableBy)}
              disabled={lockedAsSystem || (opt.v === 'SYSTEM' && !isAdmin)}
              title={opt.v === 'SYSTEM' && !isAdmin ? 'Only admins can promote a variable to SYSTEM' : undefined}
              style={{
                textAlign: 'left',
                padding: '7px 10px', borderRadius: 8,
                cursor: (lockedAsSystem || (opt.v === 'SYSTEM' && !isAdmin)) ? 'default' : 'pointer',
                border: `1.5px solid ${editableBy === opt.v ? opt.color : 'var(--color-outline-variant)'}`,
                background: editableBy === opt.v ? `${opt.color}10` : 'transparent',
                opacity: (opt.v === 'SYSTEM' && !isAdmin) ? 0.55 : 1,
              }}
            >
              <p style={{ fontSize: 11, fontWeight: 700, color: editableBy === opt.v ? opt.color : 'var(--color-on-surface)', margin: 0 }}>{opt.label}</p>
              <p style={{ fontSize: 10, color: 'var(--color-outline)', marginTop: 3, lineHeight: 1.4 }}>{opt.desc}</p>
            </button>
          ))}
        </div>
        {lockedAsSystem && (
          <p style={{ fontSize: 10, color: '#d97706', marginTop: 6 }}>
            This is a SYSTEM variable. Only admins can edit or delete it.
          </p>
        )}
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 9, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 4 }}>
          {scope === 'INSTANCE' ? 'Default value *' : 'Value *'}
        </label>
        {type === 'BOOLEAN' ? (
          <select value={String(valueRaw === 'true')} onChange={e => setValueRaw(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : type === 'JSON' ? (
          <textarea value={valueRaw} onChange={e => setValueRaw(e.target.value)} rows={3} placeholder='{"region": "us-east-1"}' style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace' }} />
        ) : (
          <input value={valueRaw} onChange={e => setValueRaw(e.target.value)} placeholder={type === 'NUMBER' ? '42' : 'Acme Corp'} style={inputStyle} />
        )}
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 9, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 4 }}>Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional. Where is this used?" style={inputStyle} />
      </div>

      {(parseError || error) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 7, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 11, marginBottom: 10 }}>
          <AlertCircle size={11} /> {parseError ?? error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 7, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: '1px solid var(--color-outline-variant)', background: '#fff', color: 'var(--color-outline)', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
          <X size={11} /> Cancel
        </button>
        <button
          disabled={saving || !key.trim()}
          onClick={handleSubmit}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: 'none', background: 'var(--color-primary)', color: '#fff', cursor: saving || !key.trim() ? 'default' : 'pointer', fontSize: 11, fontWeight: 700, opacity: saving || !key.trim() ? 0.5 : 1 }}
        >
          <Save size={11} /> {saving ? 'Saving…' : (initial ? 'Update' : 'Create')}
        </button>
      </div>
    </div>
  )
}
