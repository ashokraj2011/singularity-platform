import {
  GripVertical, ChevronUp, ChevronDown, Trash2, Plus,
  Type, AlignLeft, Hash, Calendar, Mail, Link as LinkIcon, Phone, ToggleLeft,
  ChevronsUpDown, ListChecks, CheckSquare, PenLine, Paperclip,
  FileText, Heading as HeadingIcon, Minus,
} from 'lucide-react'
import type { FormWidget, WidgetType } from './types'
import { WIDGET_CATALOG, newWidget } from './types'

const WIDGET_ICONS: Record<WidgetType, React.ElementType> = {
  SHORT_TEXT:   Type,
  LONG_TEXT:    AlignLeft,
  NUMBER:       Hash,
  DATE:         Calendar,
  EMAIL:        Mail,
  URL:          LinkIcon,
  PHONE:        Phone,
  BOOLEAN:      ToggleLeft,
  SELECT:       ChevronsUpDown,
  MULTI_SELECT: ListChecks,
  CHECKLIST:    CheckSquare,
  SIGNATURE:    PenLine,
  FILE_UPLOAD:  Paperclip,
  INSTRUCTIONS: FileText,
  HEADING:      HeadingIcon,
  DIVIDER:      Minus,
}

export function WidgetIcon({ type, size = 12 }: { type: WidgetType; size?: number }) {
  const Icon = WIDGET_ICONS[type]
  return <Icon size={size} />
}

/** Left rail of the form builder — list of widgets + "Add widget" picker. */
export function WidgetListEditor({
  widgets, selectedId, onSelect, onChange,
  density = 'comfortable',
}: {
  widgets:    FormWidget[]
  selectedId: string | null
  onSelect:   (id: string) => void
  onChange:   (next: FormWidget[]) => void
  density?:   'comfortable' | 'compact'
}) {
  const compact = density === 'compact'

  const add = (type: WidgetType) => {
    const w = newWidget(type)
    onChange([...widgets, w])
    onSelect(w.id)
  }

  const move = (id: string, dir: -1 | 1) => {
    const idx = widgets.findIndex(w => w.id === id)
    const next = idx + dir
    if (next < 0 || next >= widgets.length) return
    const arr = [...widgets]
    ;[arr[idx], arr[next]] = [arr[next], arr[idx]]
    onChange(arr)
  }

  const remove = (id: string) => onChange(widgets.filter(w => w.id !== id))

  return (
    <div>
      <p style={{
        fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.13em', color: 'var(--color-outline)', marginBottom: 8,
      }}>
        Widgets
      </p>

      {widgets.length === 0 && (
        <p style={{ fontSize: 11, color: 'var(--color-outline)', fontStyle: 'italic', marginBottom: 8 }}>
          No widgets yet. Pick one below to add it.
        </p>
      )}

      {widgets.map((w, i) => {
        const meta  = WIDGET_CATALOG.find(c => c.type === w.type)
        const label = w.label || (w.type === 'DIVIDER' ? '— divider —' : meta?.label) || w.type
        const isSelected = selectedId === w.id
        return (
          <div
            key={w.id}
            onClick={() => onSelect(w.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: compact ? '6px 8px' : '8px 10px',
              borderRadius: 9, marginBottom: 4, cursor: 'pointer',
              background:  isSelected ? 'rgba(0,132,61,0.08)' : '#fff',
              border: `1px solid ${isSelected ? 'rgba(0,132,61,0.25)' : 'var(--color-outline-variant)'}`,
              transition: 'all 0.1s',
            }}
          >
            <GripVertical size={11} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />
            <WidgetIcon type={w.type} size={11} />
            <span style={{
              flex: 1, fontSize: 11, fontWeight: 600,
              color: 'var(--color-on-surface)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {label}
            </span>
            {w.required && (
              <span title="Required" style={{
                fontSize: 8, fontWeight: 800, color: '#ef4444',
                letterSpacing: '0.08em',
              }}>
                REQ
              </span>
            )}
            <div style={{ display: 'flex', gap: 1, flexShrink: 0 }}>
              <button
                onClick={e => { e.stopPropagation(); move(w.id, -1) }}
                disabled={i === 0}
                style={{ background: 'none', border: 'none', cursor: i === 0 ? 'default' : 'pointer', color: 'var(--color-outline)', padding: 2, opacity: i === 0 ? 0.3 : 1 }}
              >
                <ChevronUp size={10} />
              </button>
              <button
                onClick={e => { e.stopPropagation(); move(w.id, 1) }}
                disabled={i === widgets.length - 1}
                style={{ background: 'none', border: 'none', cursor: i === widgets.length - 1 ? 'default' : 'pointer', color: 'var(--color-outline)', padding: 2, opacity: i === widgets.length - 1 ? 0.3 : 1 }}
              >
                <ChevronDown size={10} />
              </button>
              <button
                onClick={e => { e.stopPropagation(); remove(w.id) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 2 }}
              >
                <Trash2 size={10} />
              </button>
            </div>
          </div>
        )
      })}

      {/* Add widget picker */}
      <div style={{ marginTop: 8 }}>
        <p style={{
          fontSize: 9, fontWeight: 700, color: 'var(--color-outline)',
          textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6,
        }}>
          Add widget
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
          {WIDGET_CATALOG.map(c => (
            <button
              key={c.type}
              onClick={() => add(c.type)}
              title={c.description}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 8px', borderRadius: 7, cursor: 'pointer',
                border: '1px dashed var(--color-outline-variant)',
                background: 'transparent',
                fontSize: 10, fontWeight: 600,
                color: 'var(--color-outline)',
                transition: 'all 0.1s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-primary)'
                ;(e.currentTarget as HTMLButtonElement).style.color       = 'var(--color-primary)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-outline-variant)'
                ;(e.currentTarget as HTMLButtonElement).style.color       = 'var(--color-outline)'
              }}
            >
              <Plus size={9} />
              <WidgetIcon type={c.type} size={10} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.label}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
