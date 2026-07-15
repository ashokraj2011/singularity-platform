import type { CSSProperties, ComponentType, ReactNode } from 'react'
import { Sun, Moon, ArrowLeft } from 'lucide-react'
import { ideTokens, type IdeTheme } from './ideTheme'

/**
 * IdeShell — the shared IDE chrome, extracted from WorkItemIde so both the Work Item IDE and the
 * Studio Project surface render as one product: an activity bar (view switch + tool buttons), a top
 * bar (breadcrumb + status badge), an optional right panel, and a status-bar footer. Purely
 * presentational — it owns no data; callers pass views, slots and the theme. Applies ideTokens(theme)
 * on the container so everything inside (including embedded studios that consume var(--color-*))
 * inherits the ELM palette and responds to the light/dark toggle.
 */

export interface IdeShellView<K extends string = string> {
  key: K
  label: string
  Icon: ComponentType<{ size?: number | string }>
}

export interface IdeShellProps<K extends string = string> {
  theme: IdeTheme
  onToggleTheme: () => void
  views: IdeShellView<K>[]
  view: K
  onSelectView: (key: K) => void
  onBack?: () => void
  backLabel?: string
  /** Extra activity-bar buttons rendered in the bottom group, above theme/back (e.g. Agent Storm). */
  bottomButtons?: ReactNode
  /** Top-bar left content — typically the breadcrumb (code ▸ title ▸ section). */
  breadcrumb: ReactNode
  /** Top-bar right pill (e.g. work item status). */
  statusBadge?: ReactNode
  /** Extra top-bar content after the badge (e.g. a re-open button). */
  topBarExtra?: ReactNode
  /** Optional panel docked to the right of the editor (e.g. Agent Storm). */
  rightPanel?: ReactNode
  /** Footer status segments (left / middle). Compose with <IdeStatusSeg>. */
  statusItems?: ReactNode
  /** Footer status segments pinned to the right, before the theme toggle. */
  statusRight?: ReactNode
  /** Shell height. Defaults to the embedded Work Item IDE offset; pass '100vh' for full-bleed routes. */
  height?: string
  /** Drop the card border + radius for full-bleed routes (e.g. /studio). */
  chromeless?: boolean
  children: ReactNode
}

export function IdeShell<K extends string = string>({
  theme, onToggleTheme, views, view, onSelectView, onBack, backLabel = 'Back',
  bottomButtons, breadcrumb, statusBadge, topBarExtra, rightPanel, statusItems, statusRight,
  height = 'calc(100dvh - 52px)', chromeless = false, children,
}: IdeShellProps<K>) {
  const shell: CSSProperties = {
    ...(ideTokens(theme) as CSSProperties),
    background: 'var(--ide-bg)', color: 'var(--ide-ink)',
    display: 'grid', gridTemplateColumns: '54px 1fr', gridTemplateRows: 'minmax(0,1fr) 28px',
    height, minHeight: 560,
    borderRadius: chromeless ? 0 : 12, overflow: 'hidden', border: chromeless ? 'none' : '1px solid var(--ide-line)',
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  }
  return (
    <div style={shell}>
      {/* Activity bar */}
      <nav style={{ gridColumn: 1, gridRow: 1, background: 'var(--ide-activity)', borderRight: '1px solid var(--ide-line)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0', gap: 4 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(150deg, var(--ide-accent), var(--color-primary-dark))', display: 'grid', placeItems: 'center', color: 'var(--ide-accent-ink)', marginBottom: 8 }}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round"><path d="M4 5h16M4 12h10M4 19h16" /><circle cx="18" cy="12" r="2.3" fill="currentColor" stroke="none" /></svg>
        </div>
        {views.map(({ key, label, Icon }) => (
          <IdeActBtn key={key} label={label} active={view === key} onClick={() => onSelectView(key)}><Icon size={20} /></IdeActBtn>
        ))}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {bottomButtons}
          <IdeActBtn label="Toggle theme" onClick={onToggleTheme}>{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</IdeActBtn>
          {onBack && <IdeActBtn label={backLabel} onClick={onBack}><ArrowLeft size={19} /></IdeActBtn>}
        </div>
      </nav>

      {/* Main */}
      <div style={{ gridColumn: 2, gridRow: 1, display: 'flex', minWidth: 0, minHeight: 0 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <header style={{ height: 46, flex: 'none', borderBottom: '1px solid var(--ide-line)', background: 'var(--ide-chrome)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px' }}>
            {breadcrumb}
            {statusBadge && <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: 'var(--ide-accent-soft)', color: 'var(--ide-accent)' }}>{statusBadge}</span>}
            {topBarExtra}
          </header>
          <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px 40px', background: 'var(--ide-editor)' }}>
            {children}
          </div>
        </div>
        {rightPanel}
      </div>

      {/* Status bar */}
      <footer style={{ gridColumn: '1 / -1', gridRow: 2, background: 'var(--ide-accent)', color: 'var(--ide-accent-ink)', display: 'flex', alignItems: 'center', fontFamily: 'var(--mono, ui-monospace)', fontSize: 11, fontWeight: 600 }}>
        {statusItems}
        <div style={{ marginLeft: 'auto', display: 'flex' }}>
          {statusRight}
          <button onClick={onToggleTheme} style={{ border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', padding: '0 11px', height: '100%', display: 'flex', alignItems: 'center', gap: 6 }}>◐ {theme}</button>
        </div>
      </footer>
    </div>
  )
}

export function IdeActBtn({ children, label, active, onClick }: { children: ReactNode; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} style={{
      width: 42, height: 42, borderRadius: 9, display: 'grid', placeItems: 'center', cursor: 'pointer', position: 'relative',
      border: 'none', background: active ? 'var(--ide-hover)' : 'transparent', color: active ? 'var(--ide-accent)' : 'var(--ide-muted)',
    }}>
      {active && <span style={{ position: 'absolute', left: -6, top: 9, bottom: 9, width: 2, borderRadius: 2, background: 'var(--ide-accent)' }} />}
      {children}
    </button>
  )
}

export function IdeStatusSeg({ children }: { children: ReactNode }) {
  return <span style={{ padding: '0 11px', height: '100%', display: 'flex', alignItems: 'center', gap: 6 }}>{children}</span>
}
