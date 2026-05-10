import { Plus, Trash2 } from 'lucide-react'
import type { FormWidget, SelectOption, ChecklistItem } from './types'
import { uid, deriveKey, widgetHasValue } from './types'

/**
 * Right panel of the form builder — edits the currently-selected widget's
 * label / key / required / help text / type-specific config.
 */
export function WidgetEditor({
  widget, onChange,
}: {
  widget:   FormWidget
  onChange: (next: FormWidget) => void
}) {
  const set = <K extends keyof FormWidget>(k: K, v: FormWidget[K]) =>
    onChange({ ...widget, [k]: v })

  const valueCarrying = widgetHasValue(widget.type)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Display-only widgets get their own minimal editors */}
      {widget.type === 'INSTRUCTIONS' && (
        <div>
          <Label text="Body" />
          <textarea
            value={widget.content ?? ''}
            onChange={e => set('content', e.target.value)}
            rows={5}
            placeholder="Add guidance text shown to the assignee…"
            style={{ ...input(), resize: 'vertical' }}
          />
        </div>
      )}

      {widget.type === 'HEADING' && (
        <>
          <div>
            <Label text="Heading text" />
            <input
              value={widget.label ?? ''}
              onChange={e => set('label', e.target.value)}
              placeholder="Section heading"
              style={input()}
            />
          </div>
          <div>
            <Label text="Level" />
            <select
              value={widget.level ?? 2}
              onChange={e => set('level', Number(e.target.value) as 1 | 2 | 3)}
              style={{ ...input(), cursor: 'pointer' }}
            >
              <option value={1}>H1 — large</option>
              <option value={2}>H2 — medium</option>
              <option value={3}>H3 — small</option>
            </select>
          </div>
        </>
      )}

      {widget.type === 'DIVIDER' && (
        <p style={{ fontSize: 11, color: 'var(--color-outline)', fontStyle: 'italic', padding: 12, borderRadius: 7, border: '1px dashed var(--color-outline-variant)' }}>
          A horizontal line. No properties to configure.
        </p>
      )}

      {/* All input widgets share label / key / required / help */}
      {valueCarrying && (
        <>
          <div>
            <Label text="Label" required />
            <input
              value={widget.label ?? ''}
              onChange={e => {
                // Keep `key` in sync with `label` if the key is empty or
                // matches the previous derived form (auto-tracking).
                const prev    = widget.label ?? ''
                const prevKey = deriveKey(prev)
                const next    = e.target.value
                const patch: Partial<FormWidget> = { label: next }
                if (!widget.key || widget.key === prevKey) patch.key = deriveKey(next)
                onChange({ ...widget, ...patch })
              }}
              placeholder="Customer email"
              style={input()}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <Label text="Key" />
              <input
                value={widget.key ?? ''}
                onChange={e => set('key', e.target.value.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64))}
                placeholder="customer_email"
                style={{ ...input(), fontFamily: 'monospace' }}
              />
            </div>
            <div>
              <Label text="Mandatory?" />
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', height: 28 }}>
                <input
                  type="checkbox"
                  checked={widget.required ?? false}
                  onChange={e => set('required', e.target.checked)}
                  style={{ width: 14, height: 14 }}
                />
                <span style={{ fontSize: 12, color: 'var(--color-on-surface)' }}>
                  {widget.required ? 'Required' : 'Optional'}
                </span>
              </label>
            </div>
          </div>
          <div>
            <Label text="Help text" />
            <input
              value={widget.helpText ?? ''}
              onChange={e => set('helpText', e.target.value)}
              placeholder="Shown beneath the input"
              style={input()}
            />
          </div>
        </>
      )}

      {/* ── Type-specific editors ──────────────────────────────────────────── */}

      {(widget.type === 'SHORT_TEXT' || widget.type === 'EMAIL' ||
        widget.type === 'URL'        || widget.type === 'PHONE') && (
        <div>
          <Label text="Placeholder" />
          <input
            value={widget.placeholder ?? ''}
            onChange={e => set('placeholder', e.target.value)}
            placeholder="Hint shown inside the input"
            style={input()}
          />
        </div>
      )}

      {widget.type === 'LONG_TEXT' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 12 }}>
          <div>
            <Label text="Placeholder" />
            <input
              value={widget.placeholder ?? ''}
              onChange={e => set('placeholder', e.target.value)}
              style={input()}
            />
          </div>
          <div>
            <Label text="Rows" />
            <input
              type="number" min={2} max={20}
              value={widget.rows ?? 4}
              onChange={e => set('rows', Number(e.target.value))}
              style={input()}
            />
          </div>
        </div>
      )}

      {widget.type === 'NUMBER' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div>
            <Label text="Min" />
            <input
              type="number"
              value={widget.min ?? ''}
              onChange={e => set('min', e.target.value === '' ? undefined : Number(e.target.value))}
              style={input()}
            />
          </div>
          <div>
            <Label text="Max" />
            <input
              type="number"
              value={widget.max ?? ''}
              onChange={e => set('max', e.target.value === '' ? undefined : Number(e.target.value))}
              style={input()}
            />
          </div>
          <div>
            <Label text="Step" />
            <input
              type="number" step="any"
              value={widget.step ?? ''}
              onChange={e => set('step', e.target.value === '' ? undefined : Number(e.target.value))}
              style={input()}
            />
          </div>
        </div>
      )}

      {(widget.type === 'SELECT' || widget.type === 'MULTI_SELECT') && (
        <OptionsEditor
          options={widget.options ?? []}
          onChange={options => set('options', options)}
        />
      )}

      {widget.type === 'CHECKLIST' && (
        <ChecklistItemsEditor
          items={widget.items ?? []}
          onChange={items => set('items', items)}
        />
      )}

      {widget.type === 'FILE_UPLOAD' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12 }}>
          <div>
            <Label text="Accepted types" />
            <input
              value={widget.accept ?? ''}
              onChange={e => set('accept', e.target.value)}
              placeholder="application/pdf,image/* (blank = any)"
              style={input()}
            />
          </div>
          <div>
            <Label text="Allow multiple?" />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', height: 28 }}>
              <input
                type="checkbox"
                checked={widget.multiple ?? false}
                onChange={e => set('multiple', e.target.checked)}
                style={{ width: 14, height: 14 }}
              />
              <span style={{ fontSize: 12, color: 'var(--color-on-surface)' }}>
                {widget.multiple ? 'Multiple files' : 'Single file'}
              </span>
            </label>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sub-editors ──────────────────────────────────────────────────────────────

function OptionsEditor({
  options, onChange,
}: {
  options:  SelectOption[]
  onChange: (next: SelectOption[]) => void
}) {
  const update = (i: number, patch: Partial<SelectOption>) =>
    onChange(options.map((o, idx) => idx === i ? { ...o, ...patch } : o))
  const remove = (i: number) =>
    onChange(options.filter((_, idx) => idx !== i))
  const add = () =>
    onChange([...options, { value: `opt_${uid()}`, label: 'New option' }])

  return (
    <div>
      <Label text="Options" />
      {options.map((o, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 28px', gap: 6, marginBottom: 6 }}>
          <input
            value={o.label}
            onChange={e => update(i, { label: e.target.value })}
            placeholder="Display label"
            style={input()}
          />
          <input
            value={o.value}
            onChange={e => update(i, { value: e.target.value })}
            placeholder="value"
            style={{ ...input(), fontFamily: 'monospace' }}
          />
          <button onClick={() => remove(i)} style={iconBtn()}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button onClick={add} style={dashedAddBtn()}>
        <Plus size={11} /> Add option
      </button>
    </div>
  )
}

function ChecklistItemsEditor({
  items, onChange,
}: {
  items:    ChecklistItem[]
  onChange: (next: ChecklistItem[]) => void
}) {
  const update = (id: string, label: string) =>
    onChange(items.map(it => it.id === id ? { ...it, label } : it))
  const remove = (id: string) =>
    onChange(items.filter(it => it.id !== id))
  const add = () =>
    onChange([...items, { id: uid(), label: 'New item' }])

  return (
    <div>
      <Label text="Checklist items" />
      {items.map(it => (
        <div key={it.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 5 }}>
          <input
            value={it.label}
            onChange={e => update(it.id, e.target.value)}
            placeholder="Item text"
            style={{ ...input(), flex: 1 }}
          />
          <button onClick={() => remove(it.id)} style={iconBtn()}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button onClick={add} style={dashedAddBtn()}>
        <Plus size={11} /> Add item
      </button>
    </div>
  )
}

// ── Style helpers ────────────────────────────────────────────────────────────

function input(): React.CSSProperties {
  return {
    width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 7,
    border: '1px solid var(--color-outline-variant)', fontSize: 12,
    outline: 'none', fontFamily: 'inherit', color: 'var(--color-on-surface)',
  }
}

function iconBtn(): React.CSSProperties {
  return {
    background: 'none', border: 'none', cursor: 'pointer',
    color: '#ef4444', padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
}

function dashedAddBtn(): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
    color: 'var(--color-primary)', background: 'none',
    border: '1px dashed var(--color-outline-variant)', borderRadius: 7,
    padding: '5px 10px', cursor: 'pointer', marginTop: 4,
  }
}

function Label({ text, required }: { text: string; required?: boolean }) {
  return (
    <label style={{
      display: 'block', fontSize: 10, fontWeight: 700, color: '#475569',
      textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5,
    }}>
      {text}{required ? ' *' : ''}
    </label>
  )
}
