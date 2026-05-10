import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Globe, Hash, Type, ToggleLeft, Braces, ChevronDown, Search, ArrowDownToLine, GitBranch } from 'lucide-react'
import type { VarPickerCategory, VarPickerEntry, VarType } from './types'

// ── Category visuals ─────────────────────────────────────────────────────────

const CAT_META: Record<VarPickerCategory, { label: string; color: string; Icon: React.ElementType }> = {
  globals: { label: 'Team Globals',         color: '#0ea5e9', Icon: Globe },
  vars:    { label: 'Template Variables',   color: '#8b5cf6', Icon: Braces },
  output:  { label: 'Upstream Outputs',     color: '#22c55e', Icon: ArrowDownToLine },
  context: { label: 'Context paths',        color: '#64748b', Icon: GitBranch },
  params:  { label: 'Params (legacy)',      color: '#94a3b8', Icon: Hash },
}

const TYPE_ICON: Record<VarType, React.ElementType> = {
  STRING:  Type,
  NUMBER:  Hash,
  BOOLEAN: ToggleLeft,
  JSON:    Braces,
}

// ── Component ────────────────────────────────────────────────────────────────

export function VariablePicker({
  value,
  onChange,
  entries,
  placeholder = 'context.path or globals.X or vars.X',
  allowFreeText = true,
  width = 240,
}: {
  value: string
  onChange: (v: string) => void
  entries: VarPickerEntry[]
  placeholder?: string
  allowFreeText?: boolean
  width?: number | string
}) {
  const [open, setOpen]   = useState(false)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!query.trim()) return entries
    const q = query.toLowerCase()
    return entries.filter(e =>
      e.path.toLowerCase().includes(q) ||
      e.label?.toLowerCase().includes(q) ||
      e.source?.toLowerCase().includes(q),
    )
  }, [entries, query])

  // Group by category in display order
  const grouped: Array<{ cat: VarPickerCategory; entries: VarPickerEntry[] }> = []
  const order: VarPickerCategory[] = ['globals', 'vars', 'output', 'context', 'params']
  for (const cat of order) {
    const xs = filtered.filter(e => e.category === cat)
    if (xs.length > 0) grouped.push({ cat, entries: xs })
  }

  const inputStyle: React.CSSProperties = {
    boxSizing: 'border-box', padding: '6px 26px 6px 9px', borderRadius: 7,
    border: '1px solid var(--color-outline-variant)', fontSize: 12,
    outline: 'none', fontFamily: 'monospace', color: 'var(--color-on-surface)',
    width: '100%', background: '#fff',
  }

  return (
    <div style={{ position: 'relative', width }}>
      <input
        value={value}
        onChange={e => { onChange(e.target.value); if (!open) setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        placeholder={placeholder}
        style={inputStyle}
        readOnly={!allowFreeText}
      />
      <ChevronDown size={11} style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-outline)', pointerEvents: 'none' }} />

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.1 }}
            style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
              maxHeight: 320, overflowY: 'auto',
              background: '#fff', borderRadius: 8,
              border: '1px solid var(--color-outline-variant)',
              boxShadow: '0 6px 18px rgba(0,0,0,0.12)',
              zIndex: 50,
            }}
          >
            {/* Search bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--color-outline-variant)' }}>
              <Search size={11} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search variables…"
                style={{ flex: 1, border: 'none', outline: 'none', fontSize: 11, fontFamily: 'inherit', color: 'var(--color-on-surface)', background: 'transparent' }}
              />
            </div>

            {grouped.length === 0 ? (
              <div style={{ padding: 14, fontSize: 11, color: 'var(--color-outline)', textAlign: 'center', fontStyle: 'italic' }}>
                {entries.length === 0 ? 'No variables defined yet.' : 'No matches.'}
              </div>
            ) : (
              grouped.map(({ cat, entries }) => {
                const meta = CAT_META[cat]
                return (
                  <div key={cat}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 10px 4px', background: 'rgba(0,0,0,0.015)' }}>
                      <meta.Icon size={10} style={{ color: meta.color }} />
                      <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: meta.color }}>{meta.label}</span>
                    </div>
                    {entries.map(e => {
                      const TypeIcon = e.type ? TYPE_ICON[e.type] : null
                      return (
                        <button
                          key={e.path}
                          onMouseDown={ev => ev.preventDefault()}
                          onClick={() => { onChange(e.path); setOpen(false); setQuery('') }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            width: '100%', padding: '6px 12px',
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            textAlign: 'left', borderTop: '1px solid rgba(0,0,0,0.03)',
                          }}
                          onMouseEnter={ev => (ev.currentTarget as HTMLButtonElement).style.background = 'rgba(0,0,0,0.04)'}
                          onMouseLeave={ev => (ev.currentTarget as HTMLButtonElement).style.background = 'transparent'}
                        >
                          {TypeIcon && <TypeIcon size={10} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />}
                          <code style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 600, color: 'var(--color-on-surface)' }}>{e.path}</code>
                          {e.label && <span style={{ fontSize: 10, color: 'var(--color-outline)', marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.label}</span>}
                        </button>
                      )
                    })}
                  </div>
                )
              })
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Helper: build default entries from team globals + template vars ──────────

export function buildVariableEntries(opts: {
  teamVars?:     Array<{ key: string; label?: string; type: VarType }>
  templateVars?: Array<{ key: string; label?: string; type: VarType }>
  paramDefs?:    Array<{ key: string; label?: string }>
}): VarPickerEntry[] {
  const out: VarPickerEntry[] = []
  for (const v of opts.teamVars ?? []) {
    out.push({ category: 'globals', path: `globals.${v.key}`, label: v.label, type: v.type })
  }
  for (const v of opts.templateVars ?? []) {
    out.push({ category: 'vars',    path: `vars.${v.key}`,    label: v.label, type: v.type })
  }
  for (const p of opts.paramDefs ?? []) {
    out.push({ category: 'params',  path: `params.${p.key}`,  label: p.label })
  }
  // Add a few canonical context paths as discovery hints
  out.push({ category: 'context', path: 'context.', label: 'Free-form context path' })
  return out
}
