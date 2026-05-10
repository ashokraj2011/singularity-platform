import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import {
  ArrowLeft, Save, Plus, Trash2, ChevronUp, ChevronDown,
  FileText, User, Bot, Layers, Eye, EyeOff, GripVertical,
  CheckCircle2, Paperclip,
} from 'lucide-react'
import { api } from '../../lib/api'
import type { ArtifactTemplate, ArtifactParty, PartyRole, ArtifactType } from './ArtifactDesignerPage'
import { ARTIFACT_TYPE_LABEL, ARTIFACT_TYPE_COLOR } from './ArtifactDesignerPage'
import type { FormSection, SectionType } from '../forms/sections/types'
import { uid, newSection } from '../forms/sections/types'
import { SECTION_TYPES, SectionEditor, SectionIcon, labelStyle, inputStyle } from '../forms/sections/SectionEditor'

// ── Artifact-only constants ───────────────────────────────────────────────────

const PARTY_ROLES: Array<{ value: PartyRole; label: string; color: string; Icon: React.ElementType }> = [
  { value: 'HUMAN',  label: 'Human',  color: '#22c55e', Icon: User },
  { value: 'AGENT',  label: 'Agent',  color: '#38bdf8', Icon: Bot },
  { value: 'SYSTEM', label: 'System', color: '#94a3b8', Icon: Layers },
]

const ARTIFACT_TYPES: ArtifactType[] = ['CONTRACT', 'DELIVERABLE', 'SPECIFICATION', 'APPROVAL_BRIEF', 'HANDOFF', 'REPORT']

// ─── Artifact Preview ─────────────────────────────────────────────────────────

function ArtifactPreview({ tmpl }: { tmpl: ArtifactTemplate }) {
  const typeColor = ARTIFACT_TYPE_COLOR[tmpl.type] ?? '#64748b'
  return (
    <div style={{ padding: '24px', background: '#f8fafc', borderRadius: 12, border: '1px solid var(--color-outline-variant)', fontFamily: "'Public Sans', sans-serif", maxHeight: '70vh', overflowY: 'auto' }}>
      {/* Doc header */}
      <div style={{ borderBottom: `3px solid ${typeColor}`, paddingBottom: 16, marginBottom: 20 }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: typeColor, display: 'block', marginBottom: 6 }}>
          {ARTIFACT_TYPE_LABEL[tmpl.type]}
        </span>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: '#0f172a', marginBottom: 6 }}>{tmpl.name}</h1>
        {tmpl.description && <p style={{ fontSize: 12, color: '#64748b' }}>{tmpl.description}</p>}
      </div>

      {/* Parties */}
      {tmpl.parties?.length > 0 && (
        <div style={{ marginBottom: 20, padding: 12, borderRadius: 8, background: '#fff', border: '1px solid var(--color-outline-variant)' }}>
          <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#64748b', marginBottom: 8 }}>Parties</p>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {tmpl.parties.map(p => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {p.role === 'AGENT' ? <Bot size={12} style={{ color: '#38bdf8' }} /> : p.role === 'HUMAN' ? <User size={12} style={{ color: '#22c55e' }} /> : <Layers size={12} style={{ color: '#94a3b8' }} />}
                <span style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>{p.name}</span>
                <span style={{ fontSize: 9, color: '#94a3b8' }}>({p.role})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sections */}
      {(tmpl.sections ?? []).map((s, i) => (
        <div key={s.id} style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: '#94a3b8', fontFamily: 'monospace' }}>{String(i + 1).padStart(2, '0')}</span>
            <SectionIcon type={s.type} size={12} />
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{s.title}</h3>
            {s.required && <span style={{ fontSize: 8, fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.1em' }}>required</span>}
            <span style={{ marginLeft: 'auto', fontSize: 9, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em' }}>filled by {s.filledBy}</span>
          </div>
          {s.description && <p style={{ fontSize: 11, color: '#64748b', marginBottom: 8, fontStyle: 'italic' }}>{s.description}</p>}

          {/* Type-specific preview */}
          {s.type === 'RICH_TEXT' && (
            <div style={{ padding: '10px 12px', background: '#fff', borderRadius: 7, border: '1px dashed #cbd5e1', fontSize: 12, color: '#94a3b8', fontStyle: 'italic', minHeight: 48 }}>
              {s.placeholder || '[ Rich text content goes here ]'}
            </div>
          )}
          {s.type === 'CODE_BLOCK' && (
            <div style={{ padding: '10px 12px', background: '#0f172a', borderRadius: 7, fontSize: 11, fontFamily: 'monospace', color: '#94a3b8', minHeight: 48 }}>
              <span style={{ fontSize: 9, color: '#475569', display: 'block', marginBottom: 6 }}>{s.language ?? 'code'}</span>
              {s.placeholder || '// code goes here'}
            </div>
          )}
          {s.type === 'STRUCTURED_FIELDS' && s.fields && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {s.fields.map(f => (
                <div key={f.key} style={{ padding: '8px 10px', background: '#fff', borderRadius: 7, border: '1px solid var(--color-outline-variant)' }}>
                  <p style={{ fontSize: 9, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 3 }}>{f.label}{f.required ? ' *' : ''}</p>
                  <div style={{ height: 20, borderRadius: 4, background: '#f1f5f9' }} />
                </div>
              ))}
            </div>
          )}
          {s.type === 'TABLE' && s.columns && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: '#f1f5f9' }}>
                  {s.columns.map(c => <th key={c} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 700, color: '#475569', border: '1px solid #e2e8f0' }}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {s.columns.map(c => <td key={c} style={{ padding: '6px 10px', color: '#94a3b8', border: '1px solid #e2e8f0', fontStyle: 'italic' }}>—</td>)}
                </tr>
              </tbody>
            </table>
          )}
          {s.type === 'CHECKLIST' && s.items && (
            <div>
              {s.items.map(it => (
                <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                  <div style={{ width: 14, height: 14, borderRadius: 3, border: '1.5px solid #cbd5e1', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: '#334155' }}>{it.label}</span>
                </div>
              ))}
            </div>
          )}
          {s.type === 'SIGNATURE' && (
            <div style={{ padding: '12px', background: '#fff', borderRadius: 7, border: '1px dashed #cbd5e1', display: 'flex', gap: 20 }}>
              {(tmpl.parties ?? []).filter(p => p.required).map(p => (
                <div key={p.id} style={{ flex: 1 }}>
                  <div style={{ height: 36, borderBottom: '1px solid #334155', marginBottom: 4 }} />
                  <p style={{ fontSize: 10, color: '#64748b' }}>{p.name} · {p.role}</p>
                </div>
              ))}
              {tmpl.parties?.length === 0 && <p style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>Add parties to generate signature blocks</p>}
            </div>
          )}
          {s.type === 'FILE_ATTACHMENT' && (
            <div style={{ padding: '10px 12px', background: '#fff', borderRadius: 7, border: '1px dashed #cbd5e1', display: 'flex', alignItems: 'center', gap: 8, color: '#94a3b8' }}>
              <Paperclip size={13} />
              <span style={{ fontSize: 12, fontStyle: 'italic' }}>File attachment goes here</span>
            </div>
          )}
        </div>
      ))}

      {tmpl.sections?.length === 0 && (
        <p style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', padding: '24px 0', fontStyle: 'italic' }}>
          Add sections from the left panel to build your artifact template.
        </p>
      )}
    </div>
  )
}

// ─── Main editor ──────────────────────────────────────────────────────────────

export function ArtifactEditorPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [sections, setSections] = useState<FormSection[]>([])
  const [parties,  setParties]  = useState<ArtifactParty[]>([])
  const [name,        setName]        = useState('')
  const [description, setDescription] = useState('')
  const [type,        setType]        = useState<ArtifactType>('DELIVERABLE')
  const [teamName,    setTeamName]    = useState('')
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [dirty, setDirty] = useState(false)

  const { data: tmplData, isLoading } = useQuery<ArtifactTemplate>({
    queryKey: ['artifact-templates', id],
    queryFn: () => api.get(`/artifact-templates/${id}`).then(r => r.data),
    enabled: !!id,
  })

  useEffect(() => {
    if (tmplData) {
      setName(tmplData.name)
      setDescription(tmplData.description ?? '')
      setType(tmplData.type)
      setTeamName(tmplData.teamName ?? '')
      setSections(tmplData.sections ?? [])
      setParties(tmplData.parties ?? [])
      setDirty(false)
    }
  }, [tmplData])

  const saveMut = useMutation({
    mutationFn: (body: Partial<ArtifactTemplate>) => api.patch(`/artifact-templates/${id}`, body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['artifact-templates', id] })
      qc.invalidateQueries({ queryKey: ['artifact-templates'] })
      setDirty(false)
    },
  })

  const publishMut = useMutation({
    mutationFn: () => api.post(`/artifact-templates/${id}/publish`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['artifact-templates', id] }),
  })

  const handleSave = () => saveMut.mutate({ name, description, type, teamName, sections, parties })

  const addSection = (sectionType: SectionType) => {
    const s = newSection(sectionType, SECTION_TYPES.find(t => t.value === sectionType)!.label)
    setSections(prev => [...prev, s])
    setSelectedSectionId(s.id)
    setDirty(true)
  }

  const updateSection = (s: FormSection) => {
    setSections(prev => prev.map(sec => sec.id === s.id ? s : sec))
    setDirty(true)
  }

  const removeSection = (id: string) => {
    setSections(prev => prev.filter(s => s.id !== id))
    if (selectedSectionId === id) setSelectedSectionId(null)
    setDirty(true)
  }

  const moveSection = (id: string, dir: -1 | 1) => {
    setSections(prev => {
      const idx = prev.findIndex(s => s.id === id)
      const next = idx + dir
      if (next < 0 || next >= prev.length) return prev
      const arr = [...prev]
      ;[arr[idx], arr[next]] = [arr[next], arr[idx]]
      return arr
    })
    setDirty(true)
  }

  const addParty = () => {
    setParties(prev => [...prev, { id: uid(), name: 'New Party', role: 'HUMAN', required: true }])
    setDirty(true)
  }

  const updateParty = (id: string, patch: Partial<ArtifactParty>) => {
    setParties(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p))
    setDirty(true)
  }

  const removeParty = (id: string) => {
    setParties(prev => prev.filter(p => p.id !== id))
    setDirty(true)
  }

  const selectedSection = sections.find(s => s.id === selectedSectionId) ?? null
  const typeColor = ARTIFACT_TYPE_COLOR[type] ?? '#64748b'
  const status = tmplData?.status ?? 'DRAFT'

  if (isLoading) return <div style={{ padding: 48, textAlign: 'center', color: 'var(--color-outline)' }}>Loading…</div>

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 20px', borderBottom: '1px solid var(--color-outline-variant)',
        background: '#fff', flexShrink: 0,
      }}>
        <button onClick={() => navigate('/artifacts')} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-outline)', fontSize: 12, fontWeight: 600, padding: '5px 8px', borderRadius: 7 }}>
          <ArrowLeft size={13} /> Artifacts
        </button>
        <div style={{ width: 1, height: 20, background: 'var(--color-outline-variant)' }} />

        {/* Editable name */}
        <input
          value={name}
          onChange={e => { setName(e.target.value); setDirty(true) }}
          style={{ flex: 1, border: 'none', outline: 'none', fontSize: 15, fontWeight: 700, color: 'var(--color-on-surface)', fontFamily: 'inherit', background: 'transparent', minWidth: 0 }}
          placeholder="Artifact name…"
        />

        {/* Type selector */}
        <select
          value={type}
          onChange={e => { setType(e.target.value as ArtifactType); setDirty(true) }}
          style={{ padding: '5px 10px', borderRadius: 8, border: `1.5px solid ${typeColor}40`, background: `${typeColor}0d`, color: typeColor, fontSize: 11, fontWeight: 700, cursor: 'pointer', outline: 'none' }}
        >
          {ARTIFACT_TYPES.map(t => <option key={t} value={t}>{ARTIFACT_TYPE_LABEL[t]}</option>)}
        </select>

        {/* Status */}
        <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', padding: '3px 8px', borderRadius: 6, background: status === 'PUBLISHED' ? 'rgba(0,132,61,0.1)' : 'rgba(148,163,184,0.15)', color: status === 'PUBLISHED' ? '#00843D' : '#64748b', border: `1px solid ${status === 'PUBLISHED' ? 'rgba(0,132,61,0.25)' : 'var(--color-outline-variant)'}`, fontFamily: 'monospace' }}>
          {status}
        </span>

        <div style={{ width: 1, height: 20, background: 'var(--color-outline-variant)' }} />

        {/* Preview */}
        <button onClick={() => setPreviewOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: previewOpen ? 'rgba(99,102,241,0.08)' : 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: previewOpen ? '#6366f1' : 'var(--color-outline)' }}>
          {previewOpen ? <EyeOff size={13} /> : <Eye size={13} />}
          Preview
        </button>

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={saveMut.isPending || !dirty}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', borderRadius: 8, border: 'none', background: dirty ? 'var(--color-primary)' : 'var(--color-outline-variant)', color: dirty ? '#fff' : 'var(--color-outline)', cursor: dirty ? 'pointer' : 'default', fontSize: 12, fontWeight: 700, transition: 'all 0.15s' }}
        >
          <Save size={12} /> {saveMut.isPending ? 'Saving…' : 'Save'}
        </button>

        {/* Publish */}
        {status !== 'PUBLISHED' && (
          <button
            onClick={() => { handleSave(); publishMut.mutate() }}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', borderRadius: 8, border: '1.5px solid rgba(0,132,61,0.4)', background: 'rgba(0,132,61,0.08)', color: '#00843D', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}
          >
            <CheckCircle2 size={12} /> Publish
          </button>
        )}
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Left panel: sections + parties ──────────────────────────────── */}
        <div style={{ width: 270, borderRight: '1px solid var(--color-outline-variant)', display: 'flex', flexDirection: 'column', flexShrink: 0, background: '#fafafa', overflowY: 'auto' }}>

          {/* Sections */}
          <div style={{ padding: '14px 14px 0' }}>
            <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--color-outline)', marginBottom: 8 }}>Sections</p>
            {sections.map((s, i) => (
              <div
                key={s.id}
                onClick={() => setSelectedSectionId(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '8px 10px', borderRadius: 9, marginBottom: 4, cursor: 'pointer',
                  background: selectedSectionId === s.id ? 'rgba(0,132,61,0.08)' : '#fff',
                  border: `1px solid ${selectedSectionId === s.id ? 'rgba(0,132,61,0.25)' : 'var(--color-outline-variant)'}`,
                  transition: 'all 0.1s',
                }}
              >
                <GripVertical size={11} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />
                <SectionIcon type={s.type} size={11} />
                <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                <div style={{ display: 'flex', gap: 1, flexShrink: 0 }}>
                  <button onClick={e => { e.stopPropagation(); moveSection(s.id, -1) }} disabled={i === 0} style={{ background: 'none', border: 'none', cursor: i === 0 ? 'default' : 'pointer', color: 'var(--color-outline)', padding: 2, opacity: i === 0 ? 0.3 : 1 }}><ChevronUp size={10} /></button>
                  <button onClick={e => { e.stopPropagation(); moveSection(s.id, 1) }} disabled={i === sections.length - 1} style={{ background: 'none', border: 'none', cursor: i === sections.length - 1 ? 'default' : 'pointer', color: 'var(--color-outline)', padding: 2, opacity: i === sections.length - 1 ? 0.3 : 1 }}><ChevronDown size={10} /></button>
                  <button onClick={e => { e.stopPropagation(); removeSection(s.id) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 2 }}><Trash2 size={10} /></button>
                </div>
              </div>
            ))}

            {/* Add section buttons */}
            <div style={{ marginTop: 8, marginBottom: 16 }}>
              <p style={{ fontSize: 9, fontWeight: 700, color: 'var(--color-outline)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Add section</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                {SECTION_TYPES.map(t => (
                  <button
                    key={t.value}
                    onClick={() => addSection(t.value)}
                    title={t.desc}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      padding: '5px 8px', borderRadius: 7, cursor: 'pointer',
                      border: '1px dashed var(--color-outline-variant)', background: 'transparent',
                      fontSize: 10, fontWeight: 600, color: 'var(--color-outline)',
                      transition: 'all 0.1s',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-primary)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-primary)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-outline-variant)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-outline)' }}
                  >
                    <t.icon size={11} /> {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '0 14px' }} />

          {/* Parties */}
          <div style={{ padding: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--color-outline)' }}>Parties</p>
              <button onClick={addParty} style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-primary)', fontSize: 10, fontWeight: 700 }}>
                <Plus size={10} /> Add
              </button>
            </div>
            {parties.map(p => {
              const roleInfo = PARTY_ROLES.find(r => r.value === p.role)!
              return (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5, padding: '6px 8px', borderRadius: 8, background: '#fff', border: '1px solid var(--color-outline-variant)' }}>
                  <roleInfo.Icon size={12} style={{ color: roleInfo.color, flexShrink: 0 }} />
                  <input
                    value={p.name}
                    onChange={e => updateParty(p.id, { name: e.target.value })}
                    style={{ flex: 1, border: 'none', outline: 'none', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', color: 'var(--color-on-surface)', background: 'transparent', minWidth: 0 }}
                  />
                  <select
                    value={p.role}
                    onChange={e => updateParty(p.id, { role: e.target.value as PartyRole })}
                    style={{ border: 'none', outline: 'none', fontSize: 9, fontWeight: 700, cursor: 'pointer', color: roleInfo.color, background: 'transparent', textTransform: 'uppercase' }}
                  >
                    {PARTY_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                  <button onClick={() => removeParty(p.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 2, flexShrink: 0 }}><Trash2 size={10} /></button>
                </div>
              )
            })}
            {parties.length === 0 && (
              <p style={{ fontSize: 10, color: 'var(--color-outline)', fontStyle: 'italic' }}>
                Parties are agents, humans, or systems that participate in this artifact.
              </p>
            )}
          </div>

          {/* Metadata */}
          <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '0 14px' }} />
          <div style={{ padding: '14px' }}>
            <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--color-outline)', marginBottom: 8 }}>Metadata</p>
            <div style={{ marginBottom: 8 }}>
              <label style={{ ...labelStyle(), marginBottom: 3 }}>Team</label>
              <input value={teamName} onChange={e => { setTeamName(e.target.value); setDirty(true) }} placeholder="e.g. Engineering" style={{ ...inputStyle(), fontSize: 11 }} />
            </div>
            <div>
              <label style={{ ...labelStyle(), marginBottom: 3 }}>Description</label>
              <textarea value={description} onChange={e => { setDescription(e.target.value); setDirty(true) }} rows={2} placeholder="What is this artifact for?" style={{ ...inputStyle(), resize: 'vertical', fontSize: 11 }} />
            </div>
          </div>
        </div>

        {/* ── Centre / Right: section editor or preview ────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', background: '#fff' }}>
          <AnimatePresence mode="wait">
            {previewOpen ? (
              <motion.div key="preview" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ padding: 24 }}>
                <ArtifactPreview tmpl={{ id: id!, name, description, type, status, version: tmplData?.version ?? 1, sections, parties, teamName, createdAt: '', updatedAt: '' }} />
              </motion.div>
            ) : selectedSection ? (
              <motion.div key={selectedSection.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} style={{ padding: 24, maxWidth: 640 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
                  <SectionIcon type={selectedSection.type} size={15} />
                  <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-on-surface)' }}>Edit Section</p>
                  <span style={{ fontSize: 10, color: 'var(--color-outline)', marginLeft: 4 }}>#{sections.findIndex(s => s.id === selectedSection.id) + 1}</span>
                </div>
                <SectionEditor section={selectedSection} onChange={updateSection} />
              </motion.div>
            ) : (
              <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ padding: 48, textAlign: 'center' }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: `${typeColor}10`, border: `1px solid ${typeColor}25`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                  <FileText size={22} style={{ color: typeColor }} />
                </div>
                <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-on-surface)', marginBottom: 6 }}>
                  {sections.length === 0 ? 'Start building your artifact' : 'Select a section to edit'}
                </p>
                <p style={{ fontSize: 12, color: 'var(--color-outline)', marginBottom: 20 }}>
                  {sections.length === 0
                    ? 'Add sections from the left panel to define the structure of this artifact template.'
                    : `${sections.length} section${sections.length > 1 ? 's' : ''} · click one to edit it`}
                </p>
                {sections.length === 0 && (
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                    {SECTION_TYPES.slice(0, 4).map(t => (
                      <button key={t.value} onClick={() => addSection(t.value)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 9, border: '1px solid var(--color-outline-variant)', background: '#fafafa', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--color-outline)' }}>
                        <t.icon size={13} /> {t.label}
                      </button>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
