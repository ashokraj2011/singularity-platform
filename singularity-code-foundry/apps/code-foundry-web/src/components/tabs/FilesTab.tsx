/**
 * M42.6 — Files tab. Two-column file tree + viewer. Files marked
 * protected get a small lock chip on the left rail. The viewer caps
 * at the API's 1 MB read limit.
 */
import { useEffect, useState } from 'react'
import { api, type ArtifactRow } from '../../lib/api'

export function FilesTab({ runId }: { runId: string }) {
  const [artifacts, setArtifacts] = useState<ArtifactRow[] | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [body, setBody] = useState<{ path: string; content: string; bytes: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.listArtifacts(runId)
      .then(r => {
        if (cancelled) return
        setArtifacts(r.items)
        if (r.items.length > 0 && active === null) setActive(r.items[0].path)
      })
      .catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setBody(null)
    api.fileContent(runId, active)
      .then(b => { if (!cancelled) { setBody(b); setError(null) } })
      .catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [active, runId])

  if (error && !artifacts) return <div className="empty">{error}</div>
  if (!artifacts) return <div className="empty">Loading artifacts…</div>
  if (artifacts.length === 0) return <div className="empty">No artifacts recorded for this run.</div>

  return (
    <div className="file-viewer">
      <div className="file-tree">
        {artifacts.map(a => (
          <div
            key={a.id}
            className={`row ${a.protected ? 'protected' : 'unprotected'}${active === a.path ? ' active' : ''}`}
            onClick={() => setActive(a.path)}
            title={a.path}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {a.path.split('/').pop()}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{a.fileType}</span>
          </div>
        ))}
      </div>
      <div className="file-body">
        {error ? <div className="empty">{error}</div>
          : body ? <pre>{body.content}</pre>
          : <div className="empty">Loading file…</div>}
      </div>
    </div>
  )
}
