import { GripVertical, ChevronUp, ChevronDown, Trash2 } from 'lucide-react'
import type { FormSection, SectionType } from './types'
import { newSection } from './types'
import { SECTION_TYPES, SectionIcon } from './SectionEditor'

/**
 * SectionListEditor — list of sections with reorder/delete + "add section" buttons.
 * Used inside both the Artifact Designer and the NodeInspector form-builder tab.
 */
export function SectionListEditor({
  sections,
  selectedId,
  onSelect,
  onChange,
  density = 'comfortable',
}: {
  sections: FormSection[]
  selectedId: string | null
  onSelect: (id: string) => void
  onChange: (next: FormSection[]) => void
  density?: 'comfortable' | 'compact'
}) {
  const compact = density === 'compact'

  const add = (type: SectionType) => {
    const s = newSection(type)
    onChange([...sections, s])
    onSelect(s.id)
  }

  const move = (id: string, dir: -1 | 1) => {
    const idx = sections.findIndex(s => s.id === id)
    const next = idx + dir
    if (next < 0 || next >= sections.length) return
    const arr = [...sections]
    ;[arr[idx], arr[next]] = [arr[next], arr[idx]]
    onChange(arr)
  }

  const remove = (id: string) => onChange(sections.filter(s => s.id !== id))

  return (
    <div>
      <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--color-outline)', marginBottom: 8 }}>
        Sections
      </p>

      {sections.length === 0 && (
        <p style={{ fontSize: 11, color: 'var(--color-outline)', fontStyle: 'italic', marginBottom: 8 }}>
          No sections yet. Add one below.
        </p>
      )}

      {sections.map((s, i) => (
        <div
          key={s.id}
          onClick={() => onSelect(s.id)}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: compact ? '6px 8px' : '8px 10px',
            borderRadius: 9, marginBottom: 4, cursor: 'pointer',
            background: selectedId === s.id ? 'rgba(0,132,61,0.08)' : '#fff',
            border: `1px solid ${selectedId === s.id ? 'rgba(0,132,61,0.25)' : 'var(--color-outline-variant)'}`,
            transition: 'all 0.1s',
          }}
        >
          <GripVertical size={11} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />
          <SectionIcon type={s.type} size={11} />
          <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s.title}
          </span>
          <div style={{ display: 'flex', gap: 1, flexShrink: 0 }}>
            <button onClick={e => { e.stopPropagation(); move(s.id, -1) }} disabled={i === 0} style={{ background: 'none', border: 'none', cursor: i === 0 ? 'default' : 'pointer', color: 'var(--color-outline)', padding: 2, opacity: i === 0 ? 0.3 : 1 }}><ChevronUp size={10} /></button>
            <button onClick={e => { e.stopPropagation(); move(s.id, 1) }} disabled={i === sections.length - 1} style={{ background: 'none', border: 'none', cursor: i === sections.length - 1 ? 'default' : 'pointer', color: 'var(--color-outline)', padding: 2, opacity: i === sections.length - 1 ? 0.3 : 1 }}><ChevronDown size={10} /></button>
            <button onClick={e => { e.stopPropagation(); remove(s.id) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 2 }}><Trash2 size={10} /></button>
          </div>
        </div>
      ))}

      {/* Add section buttons */}
      <div style={{ marginTop: 8 }}>
        <p style={{ fontSize: 9, fontWeight: 700, color: 'var(--color-outline)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Add section</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
          {SECTION_TYPES.map(t => (
            <button
              key={t.value}
              onClick={() => add(t.value)}
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
  )
}
