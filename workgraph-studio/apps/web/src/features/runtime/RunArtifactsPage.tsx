/**
 * Run Artifacts — a dedicated place to see every artifact an executed run
 * produced. A run is identified by its workflow-instance id (the Run Viewer's
 * :id); artifacts hang off the blueprint session(s) that run spawned, so this
 * page calls GET /blueprint/instances/:id/artifacts which resolves the session
 * link server-side. Read-only list with per-artifact view + download.
 */
import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, FileText, Download, Package, Maximize2 } from 'lucide-react'
import { api } from '../../lib/api'
import { MarkdownView } from './MarkdownView'
import { ArtifactFullscreen } from './ArtifactFullscreen'

type RunArtifact = {
  id: string
  sessionId: string
  stage?: string | null
  stageKey?: string
  kind: string
  title: string
  content?: string | null
  payload?: Record<string, unknown> | null
  createdAt: string
  consumableId?: string
  consumableVersion?: number
  consumableStatus?: string
}

type ArtifactsResponse = {
  workflowInstanceId: string
  sessionCount: number
  count: number
  items: RunArtifact[]
}

function artifactBody(a: RunArtifact): string {
  if (typeof a.content === 'string' && a.content.length > 0) return a.content
  if (a.payload && Object.keys(a.payload).length > 0) return JSON.stringify(a.payload, null, 2)
  return ''
}

function download(a: RunArtifact) {
  const body = artifactBody(a)
  const isJson = !(typeof a.content === 'string' && a.content.length > 0)
  const blob = new Blob([body], { type: isJson ? 'application/json' : 'text/plain' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const safe = a.title.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || a.id
  link.href = url
  link.download = `${safe}${isJson ? '.json' : '.txt'}`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function RunArtifactsPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [openId, setOpenId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data, isLoading, isError, error } = useQuery<ArtifactsResponse>({
    queryKey: ['run-artifacts', id],
    queryFn: () => api.get(`/blueprint/instances/${id}/artifacts`).then(r => r.data),
    enabled: !!id,
  })

  const items = useMemo(() => data?.items ?? [], [data])
  const expandedArtifact = items.find(a => a.id === expandedId)

  if (!id) return null

  return (
    <div style={{ padding: 24, maxWidth: 880, margin: '0 auto' }}>
      <button
        onClick={() => navigate(-1)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
          border: '1px solid var(--color-outline-variant)', background: 'transparent',
          cursor: 'pointer', color: 'var(--color-outline)', fontSize: 12, fontWeight: 600, marginBottom: 14,
        }}
      >
        <ArrowLeft size={12} /> Back to run
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 9,
          background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.28)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d97706', flexShrink: 0,
        }}>
          <Package size={16} />
        </div>
        <div>
          <h1 style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-on-surface)', letterSpacing: '-0.01em' }}>
            Run artifacts
          </h1>
          <p style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 2 }}>
            {isLoading ? 'Loading…'
              : `${data?.count ?? 0} artifact${(data?.count ?? 0) === 1 ? '' : 's'} across ${data?.sessionCount ?? 0} session${(data?.sessionCount ?? 0) === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>

      {isError && (
        <p style={{ padding: 16, color: '#ef4444', fontSize: 13 }}>
          Could not load artifacts: {(error as Error)?.message ?? 'unknown error'}
        </p>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <p style={{ padding: 24, color: 'var(--color-outline)', fontSize: 13, textAlign: 'center' }}>
          This run hasn’t produced any artifacts yet.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map(a => {
          const open = openId === a.id
          const body = artifactBody(a)
          return (
            <div key={a.id} style={{
              borderRadius: 10, border: '1px solid var(--color-outline-variant)', background: '#fff', overflow: 'hidden',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px' }}>
                <FileText size={15} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.title}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--color-outline)', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{a.kind}</span>
                    {a.stageKey && <span>· {a.stageKey}</span>}
                    {a.consumableId && <span title={`consumable ${a.consumableId}`}>· consumable v{a.consumableVersion ?? '?'} {a.consumableStatus ?? ''}</span>}
                    <span>· {new Date(a.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <button
                  onClick={() => setOpenId(open ? null : a.id)}
                  style={{ fontSize: 11, fontWeight: 600, padding: '4px 9px', borderRadius: 6, border: '1px solid var(--color-outline-variant)', background: 'transparent', cursor: 'pointer', color: 'var(--color-outline)' }}
                >
                  {open ? 'Hide' : 'View'}
                </button>
                <button
                  onClick={() => download(a)}
                  disabled={!body}
                  title={body ? 'Download' : 'Nothing to download'}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, padding: '4px 9px', borderRadius: 6, border: '1px solid var(--color-outline-variant)', background: 'transparent', cursor: body ? 'pointer' : 'not-allowed', color: 'var(--color-outline)', opacity: body ? 1 : 0.5 }}
                >
                  <Download size={11} /> Download
                </button>
                <button
                  onClick={() => setExpandedId(a.id)}
                  disabled={!body}
                  title={body ? 'Expand to full screen' : 'Nothing to show'}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, padding: '4px 9px', borderRadius: 6, border: '1px solid var(--color-outline-variant)', background: 'transparent', cursor: body ? 'pointer' : 'not-allowed', color: 'var(--color-outline)', opacity: body ? 1 : 0.5 }}
                >
                  <Maximize2 size={11} /> Expand
                </button>
              </div>
              {open && (
                <div style={{
                  padding: '12px 14px', borderTop: '1px solid var(--color-outline-variant)',
                  background: '#fafafa', maxHeight: 480, overflow: 'auto',
                }}>
                  {typeof a.content === 'string' && a.content.length > 0
                    ? <MarkdownView source={a.content} />
                    : (
                      <pre style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-on-surface)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {body || '(no content)'}
                      </pre>
                    )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {expandedArtifact && (
        <ArtifactFullscreen
          title={expandedArtifact.title}
          content={expandedArtifact.content}
          body={artifactBody(expandedArtifact)}
          canDownload={!!artifactBody(expandedArtifact)}
          onDownload={() => download(expandedArtifact)}
          onClose={() => setExpandedId(null)}
        />
      )}
    </div>
  )
}
