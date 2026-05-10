import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import {
  Plus, Trash2, Save, Edit2, X, ChevronDown, ChevronRight,
  Box, Star, Briefcase, Zap, Settings, Users, Database, Globe,
  Mail, Phone, Calendar, Clock, CheckCircle, AlertTriangle,
  FileText, Search, Filter, Cpu, Shield, Activity,
} from 'lucide-react'
import { api } from '../../lib/api'

// ─── Types ─────────────────────────────────────────────────────────────────

type FieldDef = {
  key: string
  label: string
  placeholder: string
  multiline: boolean
}

type CustomNodeType = {
  id: string
  name: string
  label: string
  description?: string
  color: string
  icon: string
  baseType: string
  fields: FieldDef[]
  supportsForms: boolean
  isActive: boolean
  createdAt: string
}

// ─── Constants ─────────────────────────────────────────────────────────────

const BASE_TYPES = [
  { value: 'HUMAN_TASK',           label: 'Human Task',       hint: 'Creates a task assigned to a person' },
  { value: 'AGENT_TASK',           label: 'Agent Task',       hint: 'Delegates to an AI agent' },
  { value: 'APPROVAL',             label: 'Approval',         hint: 'Requires an explicit approval decision' },
  { value: 'TOOL_REQUEST',         label: 'Tool Request',     hint: 'Calls an external tool/API' },
  { value: 'CONSUMABLE_CREATION',  label: 'Create Artifact',  hint: 'Produces a typed versioned artifact' },
  { value: 'POLICY_CHECK',         label: 'Policy Check',     hint: 'Evaluates a rule and auto-advances' },
  { value: 'TIMER',                label: 'Timer',            hint: 'Waits for a duration or datetime' },
  { value: 'SIGNAL_WAIT',          label: 'Signal Wait',      hint: 'Pauses until an external signal arrives' },
]

const ICON_OPTIONS: { name: string; Icon: React.ElementType }[] = [
  { name: 'Box', Icon: Box }, { name: 'Star', Icon: Star }, { name: 'Briefcase', Icon: Briefcase },
  { name: 'Zap', Icon: Zap }, { name: 'Settings', Icon: Settings }, { name: 'Users', Icon: Users },
  { name: 'Database', Icon: Database }, { name: 'Globe', Icon: Globe }, { name: 'Mail', Icon: Mail },
  { name: 'Phone', Icon: Phone }, { name: 'Calendar', Icon: Calendar }, { name: 'Clock', Icon: Clock },
  { name: 'CheckCircle', Icon: CheckCircle }, { name: 'AlertTriangle', Icon: AlertTriangle },
  { name: 'FileText', Icon: FileText }, { name: 'Search', Icon: Search }, { name: 'Filter', Icon: Filter },
  { name: 'Cpu', Icon: Cpu }, { name: 'Shield', Icon: Shield }, { name: 'Activity', Icon: Activity },
]

const ICON_MAP: Record<string, React.ElementType> = Object.fromEntries(ICON_OPTIONS.map(o => [o.name, o.Icon]))

const COLOR_PRESETS = [
  '#22c55e', '#38bdf8', '#a3e635', '#c084fc', '#fb923c',
  '#f43f5e', '#facc15', '#06b6d4', '#8b5cf6', '#34d399',
  '#f87171', '#64748b', '#a78bfa', '#fbbf24', '#4ade80',
]

function emptyField(): FieldDef {
  return { key: '', label: '', placeholder: '', multiline: false }
}

function defaultDraft(): Omit<CustomNodeType, 'id' | 'createdAt' | 'isActive'> {
  return {
    name: '',
    label: '',
    description: '',
    color: '#38bdf8',
    icon: 'Box',
    baseType: 'HUMAN_TASK',
    fields: [],
    supportsForms: false,
  }
}

// ─── Field Editor ───────────────────────────────────────────────────────────

function FieldRow({
  field, index, onChange, onDelete,
}: {
  field: FieldDef; index: number
  onChange: (f: FieldDef) => void
  onDelete: () => void
}) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto auto', gap: 8, alignItems: 'center',
      padding: '8px 12px', borderRadius: 8,
      background: 'var(--color-surface-container)',
      border: '1px solid var(--color-outline-variant)',
    }}>
      <div>
        <p style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-outline)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Key</p>
        <input
          value={field.key}
          onChange={e => onChange({ ...field, key: e.target.value })}
          placeholder={`field_${index + 1}`}
          style={inputStyle}
        />
      </div>
      <div>
        <p style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-outline)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Label</p>
        <input
          value={field.label}
          onChange={e => onChange({ ...field, label: e.target.value })}
          placeholder="Field label"
          style={inputStyle}
        />
      </div>
      <div>
        <p style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-outline)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Placeholder</p>
        <input
          value={field.placeholder}
          onChange={e => onChange({ ...field, placeholder: e.target.value })}
          placeholder="Hint text…"
          style={inputStyle}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
        <p style={{ fontSize: 9, fontWeight: 600, color: 'var(--color-outline)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Multi</p>
        <input
          type="checkbox"
          checked={field.multiline}
          onChange={e => onChange({ ...field, multiline: e.target.checked })}
          style={{ accentColor: '#00843D', width: 14, height: 14, cursor: 'pointer' }}
        />
      </div>
      <button
        onClick={onDelete}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-outline)', padding: 4, display: 'flex', marginTop: 16 }}
        onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = '#ef4444')}
        onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--color-outline)')}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

// ─── Node Type Card ─────────────────────────────────────────────────────────

function NodeTypeCard({
  type, onEdit, onDelete,
}: {
  type: CustomNodeType
  onEdit: () => void
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const Icon = ICON_MAP[type.icon] ?? Box
  const base = BASE_TYPES.find(b => b.value === type.baseType)

  return (
    <div style={{
      borderRadius: 12, border: '1px solid var(--color-outline-variant)',
      background: 'white', overflow: 'hidden',
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      transition: 'box-shadow 0.15s',
    }}
      onMouseEnter={e => ((e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.1)')}
      onMouseLeave={e => ((e.currentTarget as HTMLDivElement).style.boxShadow = '0 1px 4px rgba(0,0,0,0.06)')}
    >
      {/* Color accent bar */}
      <div style={{ height: 4, background: type.color }} />

      <div style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div
            onClick={onEdit}
            title="Edit node type"
            style={{
              width: 40, height: 40, borderRadius: 10, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: `${type.color}18`, border: `1px solid ${type.color}30`,
              cursor: 'pointer', transition: 'background 0.12s',
            }}
            onMouseEnter={e => ((e.currentTarget as HTMLDivElement).style.background = `${type.color}30`)}
            onMouseLeave={e => ((e.currentTarget as HTMLDivElement).style.background = `${type.color}18`)}
          >
            <Icon style={{ width: 18, height: 18, color: type.color }} />
          </div>
          <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={onEdit}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface)', margin: 0 }}>{type.label}</h3>
              <span style={{
                fontSize: 8, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                background: 'rgba(0,0,0,0.05)', color: 'var(--color-outline)',
                fontFamily: 'monospace', textTransform: 'uppercase',
              }}>{type.name}</span>
            </div>
            {type.description && (
              <p style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 3, lineHeight: 1.5 }}>{type.description}</p>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span style={{
                fontSize: 9, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
                background: 'var(--color-surface-container)',
                color: 'var(--color-outline)',
                border: '1px solid var(--color-outline-variant)',
              }}>
                {base?.label ?? type.baseType}
              </span>
              <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>
                {(type.fields as FieldDef[]).length} field{(type.fields as FieldDef[]).length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button
              onClick={() => setExpanded(o => !o)}
              style={{ ...iconBtnStyle, color: 'var(--color-outline)' }}
              title="Preview fields"
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <button onClick={onEdit} style={{ ...iconBtnStyle, color: '#00843D', width: 'auto', padding: '0 10px', gap: 4, display: 'flex', alignItems: 'center' }} title="Edit">
              <Edit2 size={13} />
              <span style={{ fontSize: 11, fontWeight: 600 }}>Edit</span>
            </button>
            <button onClick={onDelete} style={{ ...iconBtnStyle, color: '#ef4444' }} title="Delete">
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        <AnimatePresence>
          {expanded && (type.fields as FieldDef[]).length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              style={{ overflow: 'hidden' }}
            >
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-outline-variant)' }}>
                <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-outline)', marginBottom: 8 }}>
                  Custom fields
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(type.fields as FieldDef[]).map((f, i) => (
                    <span key={i} style={{
                      fontSize: 10, padding: '3px 8px', borderRadius: 6,
                      background: `${type.color}12`, color: type.color,
                      border: `1px solid ${type.color}25`,
                      fontFamily: 'monospace',
                    }}>
                      {f.key}
                    </span>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ─── Shared styles ──────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '7px 10px', borderRadius: 8, fontSize: 12,
  border: '1px solid var(--color-outline-variant)',
  background: 'var(--color-surface)',
  color: 'var(--color-on-surface)', outline: 'none',
  transition: 'border-color 0.12s',
}

const iconBtnStyle: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 7, border: 'none',
  background: 'var(--color-surface-container)',
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  transition: 'background 0.12s',
}

// ─── Designer Panel ─────────────────────────────────────────────────────────

function DesignerPanel({
  initial, onSave, onCancel, saving,
}: {
  initial?: CustomNodeType
  onSave: (data: Omit<CustomNodeType, 'id' | 'createdAt'>) => void
  onCancel: () => void
  saving: boolean
}) {
  const [draft, setDraft] = useState(() => initial
    ? { name: initial.name, label: initial.label, description: initial.description ?? '', color: initial.color, icon: initial.icon, baseType: initial.baseType, fields: [...(initial.fields as FieldDef[])], supportsForms: !!initial.supportsForms, isActive: initial.isActive }
    : { ...defaultDraft(), isActive: true }
  )

  const setField = <K extends keyof typeof draft>(k: K, v: typeof draft[K]) => setDraft(d => ({ ...d, [k]: v }))

  const addField = () => setDraft(d => ({ ...d, fields: [...d.fields, emptyField()] }))
  const updateField = (i: number, f: FieldDef) => setDraft(d => ({ ...d, fields: d.fields.map((x, j) => j === i ? f : x) }))
  const removeField = (i: number) => setDraft(d => ({ ...d, fields: d.fields.filter((_, j) => j !== i) }))

  const autoName = (label: string) => label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')

  const canSave = draft.label.trim().length > 0 && draft.name.trim().length > 0

  const IconPreview = ICON_MAP[draft.icon] ?? Box

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.18 }}
        style={{
          width: '100%', maxWidth: 780, maxHeight: '90vh',
          borderRadius: 16, background: 'white',
          boxShadow: '0 24px 80px rgba(0,0,0,0.3)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '18px 24px 16px',
          borderBottom: '1px solid var(--color-outline-variant)',
          display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0,
        }}>
          {/* Live preview chip */}
          <div style={{
            width: 44, height: 44, borderRadius: 12, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: `${draft.color}18`, border: `1px solid ${draft.color}40`,
            transition: 'all 0.2s',
          }}>
            <IconPreview style={{ width: 20, height: 20, color: draft.color }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-on-surface)', margin: 0 }}>
              {initial ? 'Edit node type' : 'New custom node type'}
            </h2>
            <p style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 2 }}>
              {draft.label || 'Untitled'} · {BASE_TYPES.find(b => b.value === draft.baseType)?.label}
            </p>
          </div>
          <button
            onClick={onCancel}
            style={{ ...iconBtnStyle, color: 'var(--color-outline)' }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Body (scrollable) */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Identity row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <label style={labelStyle}>Display name</label>
              <input
                value={draft.label}
                onChange={e => {
                  const l = e.target.value
                  setDraft(d => ({ ...d, label: l, name: initial ? d.name : autoName(l) }))
                }}
                placeholder="e.g. Legal Review"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Internal key (UPPER_SNAKE_CASE)</label>
              <input
                value={draft.name}
                onChange={e => setField('name', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                placeholder="LEGAL_REVIEW"
                style={{ ...inputStyle, fontFamily: 'monospace' }}
                readOnly={!!initial}
              />
              {!initial && <p style={{ fontSize: 9, color: 'var(--color-outline)', marginTop: 4 }}>Auto-generated from name. Cannot be changed after creation.</p>}
            </div>
          </div>

          <div>
            <label style={labelStyle}>Description</label>
            <textarea
              value={draft.description}
              onChange={e => setField('description', e.target.value)}
              placeholder="What this node type does in a workflow…"
              rows={2}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>

          {/* Base type */}
          <div>
            <label style={labelStyle}>Base executor</label>
            <p style={{ fontSize: 11, color: 'var(--color-outline)', marginBottom: 8 }}>
              Determines the runtime behaviour. Custom fields appear in the node inspector.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {BASE_TYPES.map(bt => (
                <button
                  key={bt.value}
                  onClick={() => setField('baseType', bt.value)}
                  style={{
                    padding: '8px 10px', borderRadius: 10, border: '1.5px solid',
                    borderColor: draft.baseType === bt.value ? '#00843D' : 'var(--color-outline-variant)',
                    background: draft.baseType === bt.value ? 'rgba(0,132,61,0.08)' : 'var(--color-surface-container)',
                    cursor: 'pointer', textAlign: 'left', transition: 'all 0.12s',
                  }}
                >
                  <p style={{ fontSize: 11, fontWeight: 600, color: draft.baseType === bt.value ? '#00843D' : 'var(--color-on-surface)', margin: 0 }}>{bt.label}</p>
                  <p style={{ fontSize: 9, color: 'var(--color-outline)', marginTop: 2, lineHeight: 1.4 }}>{bt.hint}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Supports forms toggle */}
          <div>
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '12px 14px', borderRadius: 10,
              border: `1.5px solid ${draft.supportsForms ? 'rgba(56,189,248,0.4)' : 'var(--color-outline-variant)'}`,
              background: draft.supportsForms ? 'rgba(56,189,248,0.06)' : 'var(--color-surface-container)',
              cursor: 'pointer', transition: 'all 0.12s',
            }}>
              <input
                type="checkbox"
                checked={draft.supportsForms}
                onChange={e => setField('supportsForms', e.target.checked)}
                style={{ marginTop: 2, accentColor: '#38bdf8', width: 14, height: 14 }}
              />
              <div>
                <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface)', margin: 0 }}>
                  Build runtime forms for this node type
                </p>
                <p style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 4, lineHeight: 1.4 }}>
                  When enabled, the node inspector exposes a section-based form builder
                  (text fields, tables, checklists, signatures, file uploads) that the
                  assignee fills in at runtime.
                </p>
              </div>
            </label>
          </div>

          {/* Color + Icon */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <label style={labelStyle}>Color</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {COLOR_PRESETS.map(c => (
                  <button
                    key={c}
                    onClick={() => setField('color', c)}
                    style={{
                      width: 26, height: 26, borderRadius: 6, background: c, border: '2px solid',
                      borderColor: draft.color === c ? 'var(--color-on-surface)' : 'transparent',
                      cursor: 'pointer', transition: 'transform 0.1s',
                      boxShadow: draft.color === c ? '0 0 0 2px white, 0 0 0 4px ' + c : 'none',
                    }}
                    title={c}
                  />
                ))}
                <input
                  type="color"
                  value={draft.color}
                  onChange={e => setField('color', e.target.value)}
                  style={{ width: 26, height: 26, borderRadius: 6, border: '1px solid var(--color-outline-variant)', cursor: 'pointer', padding: 1 }}
                  title="Custom color"
                />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Icon</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {ICON_OPTIONS.map(({ name, Icon }) => (
                  <button
                    key={name}
                    onClick={() => setField('icon', name)}
                    title={name}
                    style={{
                      width: 32, height: 32, borderRadius: 8, border: '1.5px solid',
                      borderColor: draft.icon === name ? draft.color : 'var(--color-outline-variant)',
                      background: draft.icon === name ? `${draft.color}15` : 'var(--color-surface-container)',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all 0.12s',
                    }}
                  >
                    <Icon style={{ width: 14, height: 14, color: draft.icon === name ? draft.color : 'var(--color-outline)' }} />
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Custom fields */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div>
                <label style={labelStyle}>Custom fields</label>
                <p style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 2 }}>
                  These appear in the Config tab when this node type is selected.
                </p>
              </div>
              <button
                onClick={addField}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                  borderRadius: 8, border: '1px solid rgba(0,132,61,0.3)',
                  background: 'rgba(0,132,61,0.08)', color: '#00843D',
                  fontSize: 11, fontWeight: 600, cursor: 'pointer',
                }}
              >
                <Plus size={12} /> Add field
              </button>
            </div>

            {draft.fields.length === 0 ? (
              <div style={{
                padding: '20px', borderRadius: 10, textAlign: 'center',
                border: '1.5px dashed var(--color-outline-variant)',
                background: 'var(--color-surface-container)',
              }}>
                <p style={{ fontSize: 12, color: 'var(--color-outline)' }}>No custom fields yet — base executor fields will be used.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {draft.fields.map((f, i) => (
                  <FieldRow key={i} field={f} index={i} onChange={nf => updateField(i, nf)} onDelete={() => removeField(i)} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--color-outline-variant)',
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexShrink: 0,
        }}>
          <button
            onClick={onCancel}
            style={{
              padding: '7px 16px', borderRadius: 8, border: '1px solid var(--color-outline-variant)',
              background: 'transparent', color: 'var(--color-on-surface)', cursor: 'pointer', fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => canSave && onSave(draft)}
            disabled={!canSave || saving}
            style={{
              padding: '7px 20px', borderRadius: 8, border: 'none',
              background: canSave && !saving ? '#00843D' : '#9ca3af',
              color: '#fff', cursor: canSave && !saving ? 'pointer' : 'not-allowed',
              fontSize: 13, fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Save size={13} />
            {saving ? 'Saving…' : (initial ? 'Save changes' : 'Create node type')}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--color-on-surface)',
  display: 'block', marginBottom: 6,
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function CustomNodeTypesPage() {
  const qc = useQueryClient()
  const [showDesigner, setShowDesigner] = useState(false)
  const [editing, setEditing] = useState<CustomNodeType | null>(null)

  const { data: types = [], isLoading } = useQuery<CustomNodeType[]>({
    queryKey: ['custom-node-types'],
    queryFn: () => api.get('/custom-node-types?active=false').then(r => r.data),
  })

  const createMut = useMutation({
    mutationFn: (data: object) => api.post('/custom-node-types', data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['custom-node-types'] }); setShowDesigner(false) },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: object }) => api.patch(`/custom-node-types/${id}`, data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['custom-node-types'] }); setEditing(null) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/custom-node-types/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-node-types'] }),
  })

  return (
    <div style={{ padding: '28px 32px', minHeight: '100%', background: 'var(--color-surface)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{
            fontSize: 20, fontWeight: 700, color: 'var(--color-on-surface)',
            fontFamily: "'Public Sans', sans-serif", margin: 0,
          }}>Node Type Designer</h1>
          <p style={{ fontSize: 13, color: 'var(--color-outline)', marginTop: 4 }}>
            Create reusable custom node types that appear in the Workflow Studio palette.
          </p>
        </div>
        <button
          onClick={() => setShowDesigner(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 18px',
            borderRadius: 10, border: 'none',
            background: '#00843D', color: '#fff',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,132,61,0.3)',
          }}
        >
          <Plus size={14} /> New node type
        </button>
      </div>

      {/* How it works banner */}
      <div style={{
        padding: '12px 16px', borderRadius: 10, marginBottom: 24,
        background: 'rgba(0,132,61,0.06)', border: '1px solid rgba(0,132,61,0.18)',
        display: 'flex', alignItems: 'flex-start', gap: 12,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          background: 'rgba(0,132,61,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Box size={16} style={{ color: '#00843D' }} />
        </div>
        <div>
          <p style={{ fontSize: 12, fontWeight: 600, color: '#00843D', marginBottom: 3 }}>How it works</p>
          <p style={{ fontSize: 11, color: 'var(--color-outline)', lineHeight: 1.6 }}>
            Custom node types appear in the Workflow Studio palette alongside built-in types.
            Each type maps to a <strong>base executor</strong> (Human Task, Tool Request, etc.) that handles runtime behaviour.
            You define the <strong>config fields</strong> your team sees in the inspector — keeping workflows consistent and descriptive.
          </p>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 120, borderRadius: 12 }} />)}
        </div>
      ) : types.length === 0 ? (
        <div style={{
          padding: '60px 32px', borderRadius: 16, textAlign: 'center',
          border: '2px dashed var(--color-outline-variant)',
          background: 'var(--color-surface-container)',
        }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: 'rgba(0,132,61,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
            <Box size={24} style={{ color: '#00843D' }} />
          </div>
          <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-on-surface)', marginBottom: 6 }}>No custom node types yet</p>
          <p style={{ fontSize: 12, color: 'var(--color-outline)', marginBottom: 18 }}>
            Design your first custom node type to extend the Workflow Studio palette.
          </p>
          <button
            onClick={() => setShowDesigner(true)}
            style={{
              padding: '8px 20px', borderRadius: 10, border: 'none',
              background: '#00843D', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Create your first node type
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {types.map(type => (
            <NodeTypeCard
              key={type.id}
              type={type}
              onEdit={() => setEditing(type)}
              onDelete={() => {
                if (confirm(`Delete "${type.label}"? This cannot be undone.`)) {
                  deleteMut.mutate(type.id)
                }
              }}
            />
          ))}
        </div>
      )}

      {/* Designer panel */}
      <AnimatePresence>
        {(showDesigner || editing) && (
          <DesignerPanel
            initial={editing ?? undefined}
            onSave={data => {
              if (editing) updateMut.mutate({ id: editing.id, data })
              else createMut.mutate(data)
            }}
            onCancel={() => { setShowDesigner(false); setEditing(null) }}
            saving={createMut.isPending || updateMut.isPending}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
