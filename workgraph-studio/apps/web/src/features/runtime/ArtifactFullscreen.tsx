/**
 * Full-screen artifact reader. Shared by the run-viewer artifact panels
 * (WorkItemArtifactsPanel, RunArtifactsPage) so the "Expand" affordance matches the
 * blueprint-workbench cockpit. Renders markdown for text content, a <pre> for payload-only,
 * with Download in the header. Click-outside or Esc collapses.
 */
import { useEffect } from 'react'
import { Download, Minimize2 } from 'lucide-react'
import { MarkdownView } from './MarkdownView'

function buttonStyle(enabled: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
    padding: '5px 10px', borderRadius: 6, border: '1px solid var(--color-outline-variant)',
    background: 'transparent', cursor: enabled ? 'pointer' : 'not-allowed',
    color: 'var(--color-outline)', opacity: enabled ? 1 : 0.5,
  }
}

export function ArtifactFullscreen({ title, content, body, canDownload, onDownload, onClose }: {
  title: string
  content?: string | null
  body: string
  canDownload: boolean
  onDownload: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ '--color-on-surface': '#f2f2f5', '--color-outline': '#b4b4bd', '--color-outline-variant': 'rgba(255,255,255,0.1)', background: '#101013', color: '#f2f2f5', borderRadius: 12, width: 'min(1100px, 100%)', height: 'min(85vh, 100%)', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 30px 90px rgba(0,0,0,0.6)' } as React.CSSProperties}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--color-outline-variant)' }}>
          <strong style={{ flex: 1, minWidth: 0, fontSize: 14, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</strong>
          <button type="button" onClick={onDownload} disabled={!canDownload} title={canDownload ? 'Download' : 'Nothing to download'} style={buttonStyle(canDownload)}>
            <Download size={12} /> Download
          </button>
          <button type="button" onClick={onClose} title="Collapse (Esc)" style={buttonStyle(true)}>
            <Minimize2 size={12} /> Collapse
          </button>
        </header>
        <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px', background: '#0b0b0d' }}>
          {typeof content === 'string' && content.length > 0
            ? <MarkdownView source={content} />
            : <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--color-on-surface)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{body || '(no content)'}</pre>}
        </div>
      </div>
    </div>
  )
}
