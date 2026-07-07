/**
 * M41.4 / M41.5 — Workbench Neo theme picker.
 *
 * Three independent axes — all persisted to localStorage:
 *
 *   COLOR    Indigo · Nightshade · Ocean · Forest
 *   SURFACE  Dark · Light
 *   FONT     Default · Serif · Mono
 *
 * The picker docks in the LoopRail footer (always reachable, never
 * fights the focus pane for space). The combined classlist applied
 * to .neo-cockpit-root is:
 *
 *   neo-cockpit-root
 *   neo-theme-<color>     (omitted when color === 'indigo' — default)
 *   neo-mode-<mode>       (omitted when mode === 'dark' — default)
 *   neo-font-<font>
 *
 * Backwards compatible with the M41.4 ship: if the older
 * 'workbench-neo-theme' key exists, we migrate it to the new
 * combined 'workbench-neo-look' shape on first load.
 */
import { useEffect, useState } from 'react'

export type NeoColor = 'indigo' | 'nightshade' | 'ocean' | 'forest'
export type NeoMode  = 'dark' | 'light'
export type NeoFont  = 'default' | 'serif' | 'mono'

export interface NeoLook {
  color: NeoColor
  mode: NeoMode
  font: NeoFont
}

const STORAGE_KEY = 'workbench-neo-look'
const LEGACY_KEY  = 'workbench-neo-theme'  // M41.4 — color only

// Default = light + warm clay so the embedded cockpit matches the platform
// (agent-and-tools globals.css). Dark + the other color themes stay one click away.
const DEFAULT_LOOK: NeoLook = { color: 'indigo', mode: 'light', font: 'default' }

const COLORS: { id: NeoColor; label: string; swatch: string; tagline: string }[] = [
  { id: 'indigo',     label: 'Platform',   swatch: '#a24428', tagline: 'Default — warm clay, matches the platform.' },
  { id: 'nightshade', label: 'Nightshade', swatch: '#a855f7', tagline: 'High-energy purple + magenta.' },
  { id: 'ocean',      label: 'Ocean',      swatch: '#0ea5e9', tagline: 'Calm blue + teal.' },
  { id: 'forest',     label: 'Forest',     swatch: '#16a34a', tagline: 'Warm natural greens.' },
]

const MODES: { id: NeoMode; label: string }[] = [
  { id: 'dark',  label: 'Dark' },
  { id: 'light', label: 'Light' },
]

const FONTS: { id: NeoFont; label: string; sample: string }[] = [
  { id: 'default', label: 'Aa',   sample: 'Default (Hanken Grotesk)' },
  { id: 'serif',   label: 'Aa',   sample: 'Serif (Georgia)' },
  { id: 'mono',    label: 'Aa',   sample: 'Mono (JetBrains Mono)' },
]

function isColor(v: unknown): v is NeoColor {
  return v === 'indigo' || v === 'nightshade' || v === 'ocean' || v === 'forest'
}
function isMode(v: unknown): v is NeoMode {
  return v === 'dark' || v === 'light'
}
function isFont(v: unknown): v is NeoFont {
  return v === 'default' || v === 'serif' || v === 'mono'
}

export function loadStoredLook(): NeoLook {
  if (typeof window === 'undefined') return DEFAULT_LOOK
  // 1. Try the combined key.
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<NeoLook>
      return {
        color: isColor(parsed.color) ? parsed.color : DEFAULT_LOOK.color,
        mode:  isMode(parsed.mode)   ? parsed.mode  : DEFAULT_LOOK.mode,
        font:  isFont(parsed.font)   ? parsed.font  : DEFAULT_LOOK.font,
      }
    } catch {
      // fall through
    }
  }
  // 2. Migrate legacy color-only key from M41.4.
  const legacy = window.localStorage.getItem(LEGACY_KEY)
  if (isColor(legacy)) {
    const migrated: NeoLook = { ...DEFAULT_LOOK, color: legacy }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
    window.localStorage.removeItem(LEGACY_KEY)
    return migrated
  }
  return DEFAULT_LOOK
}

/**
 * Build the classlist to apply on the cockpit root. Indigo + Dark are
 * the unscoped defaults so their classes are omitted — keeps the DOM
 * markup clean for the most common look.
 */
export function lookClass(look: NeoLook): string {
  const parts = ['neo-cockpit-root']
  if (look.color !== 'indigo') parts.push(`neo-theme-${look.color}`)
  if (look.mode  !== 'dark')   parts.push(`neo-mode-${look.mode}`)
  parts.push(`neo-font-${look.font}`)
  return parts.join(' ')
}

/**
 * Hook: returns [look, setLook]. Setter persists to localStorage.
 */
export function useNeoLook(): [NeoLook, (next: NeoLook) => void] {
  const [look, setLookState] = useState<NeoLook>(() => loadStoredLook())
  const setLook = (next: NeoLook) => {
    setLookState(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
  }
  // Re-sync on mount in case localStorage was populated post-first-render.
  useEffect(() => {
    const stored = loadStoredLook()
    setLookState(prev => (
      prev.color !== stored.color || prev.mode !== stored.mode || prev.font !== stored.font
        ? stored
        : prev
    ))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return [look, setLook]
}

/**
 * The picker UI. Three labelled rows — color swatches, dark/light
 * chips, font chips. The whole thing fits in the LoopRail footer at
 * roughly 110px tall.
 */
export function NeoThemePicker({
  value,
  onChange,
}: {
  value: NeoLook
  onChange: (next: NeoLook) => void
}) {
  return (
    <div className="neo-theme-picker" aria-label="Cockpit appearance">
      <div className="neo-theme-picker-row" role="radiogroup" aria-label="Color theme">
        <span className="neo-theme-picker-label">Color</span>
        <div className="neo-theme-picker-swatches">
          {COLORS.map(c => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={value.color === c.id}
              aria-label={`${c.label} — ${c.tagline}`}
              title={`${c.label} — ${c.tagline}`}
              className={`neo-theme-swatch ${value.color === c.id ? 'active' : ''}`}
              style={{ background: c.swatch }}
              onClick={() => onChange({ ...value, color: c.id })}
            />
          ))}
        </div>
      </div>

      <div className="neo-theme-picker-row" role="radiogroup" aria-label="Surface mode">
        <span className="neo-theme-picker-label">Surface</span>
        {MODES.map(m => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={value.mode === m.id}
            className={`neo-theme-chip ${value.mode === m.id ? 'active' : ''}`}
            onClick={() => onChange({ ...value, mode: m.id })}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="neo-theme-picker-row" role="radiogroup" aria-label="Font family">
        <span className="neo-theme-picker-label">Font</span>
        {FONTS.map(f => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={value.font === f.id}
            title={f.sample}
            className={`neo-theme-chip font-${f.id} ${value.font === f.id ? 'active' : ''}`}
            onClick={() => onChange({ ...value, font: f.id })}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────
 * Legacy single-axis exports kept around so anything that imported the
 * M41.4 useNeoTheme / themeClass API still compiles. These are thin
 * adapters over the new NeoLook shape.
 * ───────────────────────────────────────────────────────────────────── */

export type NeoTheme = NeoColor  // legacy alias

export function themeClass(theme: NeoTheme): string {
  return lookClass({ ...DEFAULT_LOOK, color: theme })
}

export function loadStoredTheme(): NeoTheme {
  return loadStoredLook().color
}

export function useNeoTheme(): [NeoTheme, (next: NeoTheme) => void] {
  const [look, setLook] = useNeoLook()
  return [look.color, (next) => setLook({ ...look, color: next })]
}
