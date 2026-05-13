import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  FileText, Plus, MoreHorizontal, ExternalLink, Archive, Trash2,
  Copy, Clock, Users, Bot, User, Layers, X,
} from 'lucide-react'
import { api } from '../../lib/api'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SectionType = 'RICH_TEXT' | 'STRUCTURED_FIELDS' | 'TABLE' | 'CODE_BLOCK' | 'SIGNATURE' | 'CHECKLIST' | 'FILE_ATTACHMENT'
export type PartyRole   = 'AGENT' | 'HUMAN' | 'SYSTEM'
export type FilledBy    = 'AGENT' | 'HUMAN' | 'SYSTEM' | 'ANY'

export type ArtifactSection = {
  id:             string
  title:          string
  type:           SectionType
  required:       boolean
  filledBy:       FilledBy
  description?:   string
  placeholder?:   string
  defaultContent?: string
  fields?:        Array<{ key: string; label: string; type: string; required: boolean; options?: string[] }>
  columns?:       string[]
  language?:      string
  items?:         Array<{ id: string; label: string }>
}

export type ArtifactParty = {
  id:          string
  name:        string
  role:        PartyRole
  required:    boolean
  description?: string
}

export type ArtifactType = 'CONTRACT' | 'DELIVERABLE' | 'SPECIFICATION' | 'APPROVAL_BRIEF' | 'HANDOFF' | 'REPORT'

export type ArtifactTemplate = {
  id:          string
  name:        string
  description?: string
  type:        ArtifactType
  status:      string
  version:     number
  sections:    ArtifactSection[]
  parties:     ArtifactParty[]
  teamName?:   string
  createdAt:   string
  updatedAt:   string
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const ARTIFACT_TYPE_LABEL: Record<ArtifactType, string> = {
  CONTRACT:       'Contract',
  DELIVERABLE:    'Deliverable',
  SPECIFICATION:  'Specification',
  APPROVAL_BRIEF: 'Approval Brief',
  HANDOFF:        'Handoff',
  REPORT:         'Report',
}

export const ARTIFACT_TYPE_COLOR: Record<ArtifactType, string> = {
  CONTRACT:       '#6366f1',
  DELIVERABLE:    '#00843D',
  SPECIFICATION:  '#0ea5e9',
  APPROVAL_BRIEF: '#f59e0b',
  HANDOFF:        '#8b5cf6',
  REPORT:         '#64748b',
}

export const ARTIFACT_TYPE_DESC: Record<ArtifactType, string> = {
  CONTRACT:       'Formal agreement between agents, humans, or both — defines obligations, deliverables, and sign-off requirements.',
  DELIVERABLE:    'A typed output artifact produced at the end of a workflow stage — code, document, dataset, or binary.',
  SPECIFICATION:  'Requirements or constraints document — defines what must be built or achieved.',
  APPROVAL_BRIEF: 'Structured brief presented to a decision-maker — includes context, options, and recommendation.',
  HANDOFF:        'Structured handoff package passed between workflow stages or teams — captures state and next-steps.',
  REPORT:         'Analysis or status report — narrative + data sections + conclusions.',
}

const STATUS_COLOR: Record<string, string> = {
  DRAFT: '#94a3b8', PUBLISHED: '#00843D', ARCHIVED: '#64748b',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.1em',
      padding: '2px 7px', borderRadius: 5,
      background: `${color}18`, color, border: `1px solid ${color}30`,
    }}>
      {label}
    </span>
  )
}

function PartyBadge({ role }: { role: PartyRole }) {
  const map = { AGENT: { Icon: Bot, color: '#38bdf8' }, HUMAN: { Icon: User, color: '#22c55e' }, SYSTEM: { Icon: Layers, color: '#94a3b8' } }
  const { Icon, color } = map[role]
  return <Icon size={11} style={{ color }} />
}

// ─── Template card ────────────────────────────────────────────────────────────

function TemplateCard({ tmpl, onOpen, onArchive, onDuplicate, onDelete }: {
  tmpl: ArtifactTemplate
  onOpen: () => void
  onArchive: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const typeColor  = ARTIFACT_TYPE_COLOR[tmpl.type] ?? '#64748b'
  const statusColor = STATUS_COLOR[tmpl.status] ?? '#94a3b8'
  const sectionCount = tmpl.sections?.length ?? 0
  const partyCount   = tmpl.parties?.length   ?? 0
  const uniqueRoles  = [...new Set((tmpl.parties ?? []).map(p => p.role))]

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: '#fff', border: '1px solid var(--color-outline-variant)',
        borderRadius: 14, padding: '18px 20px',
        boxShadow: '0 2px 8px rgba(12,23,39,0.04)',
        display: 'flex', flexDirection: 'column', gap: 12,
        position: 'relative',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0,
          background: `${typeColor}12`, border: `1px solid ${typeColor}25`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <FileText size={16} style={{ color: typeColor }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tmpl.name}
          </p>
          {tmpl.description && (
            <p style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {tmpl.description}
            </p>
          )}
        </div>
        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <button onClick={onOpen} style={{ padding: 5, borderRadius: 7, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-outline)' }}>
            <ExternalLink size={13} />
          </button>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setMenuOpen(o => !o)} style={{ padding: 5, borderRadius: 7, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-outline)' }}>
              <MoreHorizontal size={13} />
            </button>
            {menuOpen && (
              <div
                onClick={() => setMenuOpen(false)}
                style={{
                  position: 'absolute', right: 0, top: '110%', zIndex: 50,
                  background: '#fff', border: '1px solid var(--color-outline-variant)',
                  borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                  minWidth: 160, padding: '6px',
                }}
              >
                {[
                  { label: 'Duplicate', Icon: Copy, action: onDuplicate, color: '#475569' },
                  { label: tmpl.status === 'ARCHIVED' ? 'Unarchive' : 'Archive', Icon: Archive, action: onArchive, color: '#f59e0b' },
                  { label: 'Delete', Icon: Trash2, action: onDelete, color: '#ef4444' },
                ].map(({ label, Icon, action, color }) => (
                  <button key={label} onClick={action} style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '7px 10px', borderRadius: 7, border: 'none', background: 'none', cursor: 'pointer',
                    fontSize: 12, fontWeight: 600, color,
                    textAlign: 'left',
                  }}>
                    <Icon size={12} /> {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Badges row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Pill label={ARTIFACT_TYPE_LABEL[tmpl.type]} color={typeColor} />
        <Pill label={tmpl.status} color={statusColor} />
        {tmpl.teamName && (
          <span style={{ fontSize: 10, color: 'var(--color-outline)', display: 'flex', alignItems: 'center', gap: 3 }}>
            <Users size={9} /> {tmpl.teamName}
          </span>
        )}
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingTop: 4, borderTop: '1px solid var(--color-outline-variant)' }}>
        <span style={{ fontSize: 11, color: 'var(--color-outline)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Layers size={10} /> {sectionCount} section{sectionCount !== 1 ? 's' : ''}
        </span>
        {partyCount > 0 && (
          <span style={{ fontSize: 11, color: 'var(--color-outline)', display: 'flex', alignItems: 'center', gap: 4 }}>
            {uniqueRoles.map(r => <PartyBadge key={r} role={r} />)}
            {partyCount} part{partyCount !== 1 ? 'ies' : 'y'}
          </span>
        )}
        <span style={{ fontSize: 10, color: 'var(--color-outline)', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 3 }}>
          <Clock size={9} /> {new Date(tmpl.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
      </div>
    </motion.div>
  )
}

// ─── Create modal ─────────────────────────────────────────────────────────────

function CreateModal({ onClose, onCreate }: { onClose: () => void; onCreate: (data: { name: string; description: string; type: ArtifactType; teamName: string }) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<ArtifactType>('DELIVERABLE')
  const [teamName, setTeamName] = useState('')
  const [step, setStep] = useState<'type' | 'details'>('type')

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '8px 12px',
    borderRadius: 8, border: '1px solid var(--color-outline-variant)',
    fontSize: 13, outline: 'none', fontFamily: 'inherit', color: 'var(--color-on-surface)',
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, backdropFilter: 'blur(4px)' }}
    >
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: '100%', maxWidth: 540, boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '22px 24px 16px' }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(0,132,61,0.1)', border: '1px solid rgba(0,132,61,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <FileText size={16} style={{ color: 'var(--color-primary)' }} />
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>New Artifact Template</p>
            <p style={{ fontSize: 11, color: '#64748b' }}>Step {step === 'type' ? 1 : 2} of 2</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}><X size={16} /></button>
        </div>

        <div style={{ padding: '0 24px 20px' }}>
          {step === 'type' ? (
            <>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 12 }}>What kind of artifact is this?</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {(Object.keys(ARTIFACT_TYPE_LABEL) as ArtifactType[]).map(t => (
                  <button
                    key={t}
                    onClick={() => setType(t)}
                    style={{
                      padding: '12px 14px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                      border: `2px solid ${type === t ? ARTIFACT_TYPE_COLOR[t] : '#e2e8f0'}`,
                      background: type === t ? `${ARTIFACT_TYPE_COLOR[t]}0d` : '#f8fafc',
                      transition: 'all 0.12s',
                    }}
                  >
                    <p style={{ fontSize: 12, fontWeight: 700, color: type === t ? ARTIFACT_TYPE_COLOR[t] : '#334155', marginBottom: 4 }}>
                      {ARTIFACT_TYPE_LABEL[t]}
                    </p>
                    <p style={{ fontSize: 10, color: '#64748b', lineHeight: 1.4 }}>{ARTIFACT_TYPE_DESC[t]}</p>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>Name *</label>
                <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={`e.g. ${ARTIFACT_TYPE_LABEL[type]} Template`} style={inputStyle} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>Description</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="What does this artifact capture?" style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>Team</label>
                <input value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="e.g. Engineering" style={inputStyle} />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '14px 24px', borderTop: '1px solid var(--color-outline-variant)' }}>
          {step === 'details' && (
            <button onClick={() => setStep('type')} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: 'transparent', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#475569' }}>
              ← Back
            </button>
          )}
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: 'transparent', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#475569' }}>
            Cancel
          </button>
          {step === 'type' ? (
            <button onClick={() => setStep('details')} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              Next →
            </button>
          ) : (
            <button
              onClick={() => { if (name.trim()) onCreate({ name: name.trim(), description, type, teamName }) }}
              disabled={!name.trim()}
              style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: name.trim() ? 'pointer' : 'not-allowed', opacity: name.trim() ? 1 : 0.6 }}>
              Create & Design
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function ArtifactDesignerPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [filterType, setFilterType] = useState<string>('ALL')
  const [showArchived, setShowArchived] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['artifact-templates', showArchived],
    queryFn: () => api.get(showArchived ? '/artifact-templates?status=ARCHIVED' : '/artifact-templates').then(r => r.data),
  })

  const templates: ArtifactTemplate[] = Array.isArray(data) ? data : (data?.content ?? [])

  const createMut = useMutation({
    mutationFn: (body: object) => api.post('/artifact-templates', body).then(r => r.data),
    onSuccess: (tmpl: ArtifactTemplate) => {
      qc.invalidateQueries({ queryKey: ['artifact-templates'] })
      setCreateOpen(false)
      navigate(`/artifacts/${tmpl.id}`)
    },
  })

  const archiveMut = useMutation({
    mutationFn: (id: string) => api.post(`/artifact-templates/${id}/archive`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['artifact-templates'] }),
  })

  const duplicateMut = useMutation({
    mutationFn: (id: string) => api.post(`/artifact-templates/${id}/duplicate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['artifact-templates'] }),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/artifact-templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['artifact-templates'] }),
  })

  const filtered = templates.filter(t => filterType === 'ALL' || t.type === filterType)

  const typeCount = (t: ArtifactType) => templates.filter(tmpl => tmpl.type === t).length

  return (
    <div style={{ padding: '28px 28px 48px', maxWidth: 1100 }}>

      {/* Header */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(99,102,241,0.10)', border: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <FileText size={16} style={{ color: '#6366f1' }} />
          </div>
          <div>
            <h1 className="page-header" style={{ marginBottom: 0 }}>Artifact Studio</h1>
            <p style={{ fontSize: 11, color: 'var(--color-outline)', fontFamily: 'monospace', marginTop: 1 }}>
              {templates.length} template{templates.length !== 1 ? 's' : ''} · contracts, deliverables & specs
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => setShowArchived(v => !v)}
            style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: showArchived ? 'rgba(100,116,139,0.1)' : 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--color-outline)', display: 'flex', alignItems: 'center', gap: 5 }}
          >
            <Archive size={13} />
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          <button
            className="btn-primary"
            onClick={() => setCreateOpen(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
          >
            <Plus size={14} /> New artifact
          </button>
        </div>
      </motion.div>

      {/* Type filter tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        {(['ALL', ...Object.keys(ARTIFACT_TYPE_LABEL)] as Array<'ALL' | ArtifactType>).map(t => {
          const count = t === 'ALL' ? templates.length : typeCount(t as ArtifactType)
          const color = t === 'ALL' ? '#475569' : ARTIFACT_TYPE_COLOR[t as ArtifactType]
          const active = filterType === t
          return (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: active ? 700 : 500,
                border: `1.5px solid ${active ? color : 'var(--color-outline-variant)'}`,
                background: active ? `${color}10` : 'transparent',
                color: active ? color : 'var(--color-outline)',
                transition: 'all 0.1s',
              }}
            >
              {t === 'ALL' ? 'All' : ARTIFACT_TYPE_LABEL[t as ArtifactType]}
              <span style={{ fontSize: 10, background: active ? `${color}20` : 'var(--color-outline-variant)', padding: '1px 5px', borderRadius: 4, fontWeight: 700, color: active ? color : 'var(--color-outline)' }}>
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Grid */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--color-outline)' }}>
          <Clock size={24} style={{ margin: '0 auto 10px', opacity: 0.3 }} />
          <p style={{ fontSize: 13 }}>Loading…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '56px 0' }}>
          <FileText size={32} style={{ color: 'var(--color-outline-variant)', margin: '0 auto 12px' }} />
          <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-outline)', marginBottom: 6 }}>
            {filterType !== 'ALL' ? `No ${ARTIFACT_TYPE_LABEL[filterType as ArtifactType]} templates` : 'No artifact templates yet'}
          </p>
          <p style={{ fontSize: 12, color: 'var(--color-outline)', marginBottom: 16 }}>
            Create templates to define structured contracts, deliverables, and specs.
          </p>
          <button onClick={() => setCreateOpen(true)} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <Plus size={13} /> Create first artifact
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {filtered.map((tmpl) => (
            <TemplateCard
              key={tmpl.id}
              tmpl={tmpl}
              onOpen={() => navigate(`/artifacts/${tmpl.id}`)}
              onArchive={() => archiveMut.mutate(tmpl.id)}
              onDuplicate={() => duplicateMut.mutate(tmpl.id)}
              onDelete={() => { if (confirm(`Delete "${tmpl.name}"?`)) deleteMut.mutate(tmpl.id) }}
            />
          ))}
        </div>
      )}

      {createOpen && (
        <CreateModal
          onClose={() => setCreateOpen(false)}
          onCreate={data => createMut.mutate(data)}
        />
      )}
    </div>
  )
}
