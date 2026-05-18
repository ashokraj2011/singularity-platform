/**
 * M42.6 — Gaps tab. Read-only table of CodegenGap rows. Severity is
 * colour-coded; the region anchor is shown when present so the
 * operator can correlate a gap to its <llm-editable> fence.
 */
import { useEffect, useState } from 'react'
import { api, type GapRow } from '../../lib/api'

export function GapsTab({ runId }: { runId: string }) {
  const [gaps, setGaps] = useState<GapRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.listGaps(runId)
      .then(r => { if (!cancelled) setGaps(r.items) })
      .catch(e => { if (!cancelled) setErr(e.message) })
    return () => { cancelled = true }
  }, [runId])

  if (err) return <div className="empty">{err}</div>
  if (!gaps) return <div className="empty">Loading gaps…</div>
  if (gaps.length === 0) return <div className="empty">No gaps detected for this run.</div>

  return (
    <div className="panel">
      <h2>Gaps</h2>
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Severity</th>
            <th>File</th>
            <th>Region</th>
            <th>Resolved</th>
            <th>LLM</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {gaps.map(g => (
            <tr key={g.id}>
              <td><code>{g.gapType}</code></td>
              <td style={{ color: severityColor(g.severity) }}>{g.severity}</td>
              <td><code>{g.filePath ?? '—'}</code></td>
              <td>{g.regionId ?? '—'}</td>
              <td>{g.resolved ? '✓' : '—'}</td>
              <td>{g.llmEligible ? '✓' : '—'}</td>
              <td>{g.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function severityColor(s: GapRow['severity']): string {
  switch (s) {
    case 'critical': return 'var(--bad)'
    case 'high':     return 'var(--bad)'
    case 'medium':   return 'var(--warn)'
    case 'low':      return 'var(--text-dim)'
  }
}
