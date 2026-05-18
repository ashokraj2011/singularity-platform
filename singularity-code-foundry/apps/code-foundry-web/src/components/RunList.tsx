/**
 * M42.6 — Left-rail run list.
 *
 * Renders one row per run with mode pill, status pill, and the spec
 * name. Active row gets an accent border on the left. Empty / error
 * states render their own placeholder. The parent is responsible for
 * refresh + filter — this component is pure presentation.
 */
import type { RunSummary } from '../lib/api'

interface Props {
  runs: RunSummary[] | null
  error: string | null
  selectedId: string | null
  onSelect: (id: string) => void
}

export function RunList({ runs, error, selectedId, onSelect }: Props) {
  if (error) {
    return <div className="empty">Error loading runs: {error}</div>
  }
  if (runs === null) {
    return <div className="empty">Loading…</div>
  }
  if (runs.length === 0) {
    return <div className="empty">No runs yet. Generate one via the CLI or REST.</div>
  }
  return (
    <ul className="run-list">
      {runs.map(r => (
        <li
          key={r.id}
          className={`run-row${selectedId === r.id ? ' active' : ''}`}
          onClick={() => onSelect(r.id)}
        >
          <div className="row-head">
            <span title={r.specName ?? r.specId}>
              {r.specName ?? r.specId.slice(0, 8)}
              {r.specVersion ? <span style={{ color: 'var(--text-dim)' }}> @{r.specVersion}</span> : null}
            </span>
            <span className={`mode-pill ${r.mode.toLowerCase()}`}>{r.mode === 'GREENFIELD' ? 'G' : 'B'}</span>
          </div>
          <div className="row-meta">
            <span className={`status-pill ${classify(r.status)}`}>{r.status}</span>
            <span>{formatDate(r.startedAt)}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

function classify(status: string): 'good' | 'bad' | 'warn' | '' {
  if (['COMPLETED', 'CERTIFIED', 'VERIFIED', 'PATCHED'].includes(status)) return 'good'
  if (['FAILED'].includes(status)) return 'bad'
  if (['GAPS_DETECTED', 'STARTED', 'GENERATED'].includes(status)) return 'warn'
  return ''
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const today = new Date()
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString()
}
