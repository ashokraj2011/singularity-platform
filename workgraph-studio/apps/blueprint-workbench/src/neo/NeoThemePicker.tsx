/**
 * M41.4 — Workbench Neo theme picker.
 *
 * Four named themes (Indigo / Nightshade / Ocean / Forest) selectable
 * from a small row of color swatches. The choice persists in
 * localStorage under 'workbench-neo-theme' and applies to the entire
 * cockpit via a class on the .neo-cockpit-root wrapper.
 *
 * Lives in the LoopRail footer so it's always reachable but never
 * fights for space with the focus pane or live cockpit.
 */
import { useEffect, useState } from 'react'

export type NeoTheme = 'indigo' | 'nightshade' | 'ocean' | 'forest'

const STORAGE_KEY = 'workbench-neo-theme'
const DEFAULT_THEME: NeoTheme = 'indigo'

interface ThemeMeta {
  id: NeoTheme
  label: string
  swatch: string  // single hex for the swatch dot
  tagline: string
}

const THEMES: ThemeMeta[] = [
  { id: 'indigo',     label: 'Indigo',     swatch: '#6366f1', tagline: 'The default — indigo + emerald.' },
  { id: 'nightshade', label: 'Nightshade', swatch: '#a855f7', tagline: 'High-energy purple + magenta.' },
  { id: 'ocean',      label: 'Ocean',      swatch: '#0ea5e9', tagline: 'Calm blue + teal.' },
  { id: 'forest',     label: 'Forest',     swatch: '#16a34a', tagline: 'Warm natural greens + ambers.' },
]

export function loadStoredTheme(): NeoTheme {
  if (typeof window === 'undefined') return DEFAULT_THEME
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (stored === 'indigo' || stored === 'nightshade' || stored === 'ocean' || stored === 'forest') {
    return stored
  }
  return DEFAULT_THEME
}

export function themeClass(theme: NeoTheme): string {
  // Indigo is the unscoped default — uses the bare .neo-cockpit-root
  // rules without a modifier class.
  if (theme === 'indigo') return 'neo-cockpit-root'
  return `neo-cockpit-root neo-theme-${theme}`
}

/**
 * The picker UI. Caller controls the active theme via `value` and
 * receives changes via `onChange`. Persistence + initial load are
 * the parent's responsibility (it owns the theme class on the shell).
 */
export function NeoThemePicker({
  value,
  onChange,
}: {
  value: NeoTheme
  onChange: (next: NeoTheme) => void
}) {
  return (
    <div className="neo-theme-picker" role="radiogroup" aria-label="Color theme">
      <span className="neo-theme-picker-label">Theme</span>
      <div className="neo-theme-picker-swatches">
        {THEMES.map(t => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={value === t.id}
            aria-label={`${t.label} — ${t.tagline}`}
            title={`${t.label} — ${t.tagline}`}
            className={`neo-theme-swatch ${value === t.id ? 'active' : ''}`}
            style={{ background: t.swatch }}
            onClick={() => onChange(t.id)}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Convenience hook that wires the picker to localStorage. Returns
 * [theme, setTheme] like useState, but the setter also persists the
 * choice so it survives reloads.
 */
export function useNeoTheme(): [NeoTheme, (next: NeoTheme) => void] {
  const [theme, setThemeState] = useState<NeoTheme>(() => loadStoredTheme())
  const setTheme = (next: NeoTheme) => {
    setThemeState(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next)
    }
  }
  // Re-sync on mount in case localStorage was hydrated after first render.
  useEffect(() => {
    const stored = loadStoredTheme()
    if (stored !== theme) setThemeState(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return [theme, setTheme]
}
