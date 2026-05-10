import {
  AlignLeft, ToggleLeft, Table, Code, PenLine, CheckSquare, Paperclip,
  User, Bot, Layers, Globe, Plus, Trash2,
} from 'lucide-react'
import type { FormSection, SectionType, FilledBy } from './types'
import { uid } from './types'

// ── Section type config (shared) ─────────────────────────────────────────────

export const SECTION_TYPES: Array<{ value: SectionType; label: string; icon: React.ElementType; desc: string }> = [
  { value: 'RICH_TEXT',         label: 'Rich Text',         icon: AlignLeft,    desc: 'Free-form markdown / prose narrative' },
  { value: 'STRUCTURED_FIELDS', label: 'Structured Fields', icon: ToggleLeft,   desc: 'Form-style key-value fields with types' },
  { value: 'TABLE',             label: 'Table',             icon: Table,        desc: 'Tabular data with defined columns' },
  { value: 'CODE_BLOCK',        label: 'Code Block',        icon: Code,         desc: 'Code or structured output with syntax highlighting' },
  { value: 'SIGNATURE',         label: 'Signature',         icon: PenLine,      desc: 'Party sign-off block with timestamp' },
  { value: 'CHECKLIST',         label: 'Checklist',         icon: CheckSquare,  desc: 'List of items to check off' },
  { value: 'FILE_ATTACHMENT',   label: 'File Attachment',   icon: Paperclip,    desc: 'File reference or binary attachment slot' },
]

export const FILLED_BY_OPTIONS: Array<{ value: FilledBy; label: string; color: string; Icon: React.ElementType }> = [
  { value: 'HUMAN',  label: 'Human',  color: '#22c55e', Icon: User },
  { value: 'AGENT',  label: 'Agent',  color: '#38bdf8', Icon: Bot },
  { value: 'SYSTEM', label: 'System', color: '#94a3b8', Icon: Layers },
  { value: 'ANY',    label: 'Any',    color: '#8b5cf6', Icon: Globe },
]

// ── Style helpers ────────────────────────────────────────────────────────────

export function labelStyle(): React.CSSProperties {
  return { display: 'block', fontSize: 10, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }
}

export function inputStyle(): React.CSSProperties {
  return { width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 7, border: '1px solid var(--color-outline-variant)', fontSize: 12, outline: 'none', fontFamily: 'inherit', color: 'var(--color-on-surface)' }
}

// ── Section icon ─────────────────────────────────────────────────────────────

export function SectionIcon({ type, size = 13 }: { type: SectionType; size?: number }) {
  const map: Record<SectionType, React.ElementType> = {
    RICH_TEXT: AlignLeft, STRUCTURED_FIELDS: ToggleLeft, TABLE: Table,
    CODE_BLOCK: Code, SIGNATURE: PenLine, CHECKLIST: CheckSquare, FILE_ATTACHMENT: Paperclip,
  }
  const Icon = map[type]
  return <Icon size={size} />
}

// ── Sub-editors for each section type ────────────────────────────────────────

function StructuredFieldsEditor({ section, onChange }: { section: FormSection; onChange: (s: FormSection) => void }) {
  const fields = section.fields ?? []
  const addField    = () => onChange({ ...section, fields: [...fields, { key: `field_${uid()}`, label: 'New Field', type: 'text', required: false }] })
  const removeField = (i: number) => onChange({ ...section, fields: fields.filter((_, idx) => idx !== i) })
  const updateField = (i: number, patch: Partial<typeof fields[0]>) => onChange({ ...section, fields: fields.map((f, idx) => idx === i ? { ...f, ...patch } : f) })

  return (
    <div>
      <label style={labelStyle()}>Fields</label>
      {fields.map((f, i) => (
        <div key={f.key} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 28px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <input value={f.label} onChange={e => updateField(i, { label: e.target.value })} placeholder="Label" style={inputStyle()} />
          <select value={f.type} onChange={e => updateField(i, { type: e.target.value })} style={{ ...inputStyle(), cursor: 'pointer' }}>
            {['text', 'number', 'date', 'email', 'url', 'boolean', 'enum'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#475569', cursor: 'pointer' }}>
            <input type="checkbox" checked={f.required} onChange={e => updateField(i, { required: e.target.checked })} />
            Required
          </label>
          <button onClick={() => removeField(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 2 }}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button onClick={addField} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--color-primary)', background: 'none', border: '1px dashed var(--color-outline-variant)', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', marginTop: 4 }}>
        <Plus size={11} /> Add field
      </button>
    </div>
  )
}

function TableEditor({ section, onChange }: { section: FormSection; onChange: (s: FormSection) => void }) {
  const cols = section.columns ?? []
  const addCol    = () => onChange({ ...section, columns: [...cols, `Column ${cols.length + 1}`] })
  const updateCol = (i: number, val: string) => onChange({ ...section, columns: cols.map((c, idx) => idx === i ? val : c) })
  const removeCol = (i: number) => onChange({ ...section, columns: cols.filter((_, idx) => idx !== i) })

  return (
    <div>
      <label style={labelStyle()}>Columns</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {cols.map((c, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input value={c} onChange={e => updateCol(i, e.target.value)} style={{ ...inputStyle(), width: 120 }} />
            <button onClick={() => removeCol(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 2 }}><Trash2 size={11} /></button>
          </div>
        ))}
      </div>
      <button onClick={addCol} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--color-primary)', background: 'none', border: '1px dashed var(--color-outline-variant)', borderRadius: 7, padding: '5px 10px', cursor: 'pointer' }}>
        <Plus size={11} /> Add column
      </button>
    </div>
  )
}

function ChecklistEditor({ section, onChange }: { section: FormSection; onChange: (s: FormSection) => void }) {
  const items = section.items ?? []
  const addItem    = () => onChange({ ...section, items: [...items, { id: uid(), label: 'New item' }] })
  const updateItem = (id: string, label: string) => onChange({ ...section, items: items.map(it => it.id === id ? { ...it, label } : it) })
  const removeItem = (id: string) => onChange({ ...section, items: items.filter(it => it.id !== id) })

  return (
    <div>
      <label style={labelStyle()}>Checklist items</label>
      {items.map(item => (
        <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
          <CheckSquare size={12} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />
          <input value={item.label} onChange={e => updateItem(item.id, e.target.value)} style={{ ...inputStyle(), flex: 1 }} />
          <button onClick={() => removeItem(item.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 2 }}><Trash2 size={11} /></button>
        </div>
      ))}
      <button onClick={addItem} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--color-primary)', background: 'none', border: '1px dashed var(--color-outline-variant)', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', marginTop: 4 }}>
        <Plus size={11} /> Add item
      </button>
    </div>
  )
}

// ── Main split-pane right side: edit one section ─────────────────────────────

export function SectionEditor({ section, onChange }: { section: FormSection; onChange: (s: FormSection) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Title */}
      <div>
        <label style={labelStyle()}>Section title *</label>
        <input value={section.title} onChange={e => onChange({ ...section, title: e.target.value })} placeholder="e.g. Scope of Work" style={inputStyle()} />
      </div>

      {/* Type */}
      <div>
        <label style={labelStyle()}>Content type</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
          {SECTION_TYPES.map(t => (
            <button
              key={t.value}
              onClick={() => onChange({ ...section, type: t.value })}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px',
                borderRadius: 8, border: `1.5px solid ${section.type === t.value ? 'var(--color-primary)' : 'var(--color-outline-variant)'}`,
                background: section.type === t.value ? 'rgba(0,132,61,0.08)' : 'transparent',
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              <t.icon size={12} style={{ color: section.type === t.value ? 'var(--color-primary)' : 'var(--color-outline)', flexShrink: 0 }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: section.type === t.value ? 'var(--color-primary)' : 'var(--color-on-surface)' }}>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Filled by + Required row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle()}>Filled by</label>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {FILLED_BY_OPTIONS.map(fb => (
              <button
                key={fb.value}
                onClick={() => onChange({ ...section, filledBy: fb.value })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 10, fontWeight: 700,
                  border: `1.5px solid ${section.filledBy === fb.value ? fb.color : 'var(--color-outline-variant)'}`,
                  background: section.filledBy === fb.value ? `${fb.color}15` : 'transparent',
                  color: section.filledBy === fb.value ? fb.color : 'var(--color-outline)',
                }}
              >
                <fb.Icon size={10} /> {fb.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label style={labelStyle()}>Options</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12, color: 'var(--color-on-surface)' }}>
            <input type="checkbox" checked={section.required} onChange={e => onChange({ ...section, required: e.target.checked })} style={{ width: 14, height: 14 }} />
            Required section
          </label>
        </div>
      </div>

      {/* Description */}
      <div>
        <label style={labelStyle()}>Help text</label>
        <textarea value={section.description ?? ''} onChange={e => onChange({ ...section, description: e.target.value })} rows={2} placeholder="Instructions shown to the person filling this section…" style={{ ...inputStyle(), resize: 'vertical' }} />
      </div>

      {/* Placeholder / default content */}
      {(section.type === 'RICH_TEXT' || section.type === 'CODE_BLOCK') && (
        <div>
          <label style={labelStyle()}>Placeholder / default content</label>
          <textarea value={section.placeholder ?? ''} onChange={e => onChange({ ...section, placeholder: e.target.value })} rows={4} placeholder={section.type === 'CODE_BLOCK' ? '// paste default code here' : 'Enter default text…'} style={{ ...inputStyle(), resize: 'vertical', fontFamily: section.type === 'CODE_BLOCK' ? 'monospace' : 'inherit', fontSize: section.type === 'CODE_BLOCK' ? 11 : 12 }} />
          {section.type === 'CODE_BLOCK' && (
            <div style={{ marginTop: 6 }}>
              <label style={labelStyle()}>Language</label>
              <select value={section.language ?? 'typescript'} onChange={e => onChange({ ...section, language: e.target.value })} style={{ ...inputStyle(), cursor: 'pointer' }}>
                {['typescript', 'javascript', 'python', 'json', 'yaml', 'sql', 'bash', 'markdown', 'plaintext'].map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Type-specific editors */}
      {section.type === 'STRUCTURED_FIELDS' && <StructuredFieldsEditor section={section} onChange={onChange} />}
      {section.type === 'TABLE'             && <TableEditor             section={section} onChange={onChange} />}
      {section.type === 'CHECKLIST'         && <ChecklistEditor         section={section} onChange={onChange} />}
    </div>
  )
}
