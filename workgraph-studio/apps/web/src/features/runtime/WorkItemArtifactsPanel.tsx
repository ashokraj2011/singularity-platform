/**
 * Artifacts panel for the WorkItem detail page — shows every artifact the
 * workbench produced for this work item. A work item links to runs via its
 * source instance + each target's child instance; the server endpoint
 * (GET /blueprint/work-items/:id/artifacts) resolves those to blueprint
 * session(s) and returns their artifacts. Inline view (formatted markdown for
 * text content, JSON for payload-only) + download. Read-only.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText, Download, Package } from 'lucide-react'
import { api } from '../../lib/api'
import { MarkdownView } from './MarkdownView'

type WorkItemArtifact = {
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

type Response = { workItemId: string; instanceIds: string[]; count: number; items: WorkItemArtifact[] }

function artifactBody(a: WorkItemArtifact): string {
  if (typeof a.content === 'string' && a.content.length > 0) return a.content
  if (a.payload && Object.keys(a.payload).length > 0) return JSON.stringify(a.payload, null, 2)
  return ''
}

function download(a: WorkItemArtifact) {
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

export function WorkItemArtifactsPanel({ workItemId, cardStyle }: { workItemId: string; cardStyle: React.CSSProperties }) {
  const [openId, setOpenId] = useState<string | null>(null)

  const { data, isLoading, isError } = useQuery<Response>({
    queryKey: ['work-item-artifacts', workItemId],
    queryFn: () => api.get(`/blueprint/work-items/${workItemId}/artifacts`).then(r => r.data),
    enabled: !!workItemId,
  })

  const items = useMemo(() => data?.items ?? [], [data])

  // Don't render the panel at all when there's nothing to show (and we're not
  // mid-load / errored) — keeps the work-item page clean for items that never
  // ran the workbench.
  if (!isLoading && !isError && items.length === 0) return null

  return (
    <section style={cardStyle}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15, color: 'var(--color-on-surface)', display: 'flex', alignItems: 'center', gap: 7 }}>
        <Package size={15} style={{ color: '#d97706' }} /> Workbench artifacts
      </h3>
      <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--color-outline)' }}>
        {isLoading ? 'Loading…'
          : isError ? 'Could not load artifacts.'
          : `${data?.count ?? 0} artifact${(data?.count ?? 0) === 1 ? '' : 's'} produced for this work item.`}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map(a => {
          const open = openId === a.id
          const body = artifactBody(a)
          return (
            <div key={a.id} style={{ borderRadius: 9, border: '1px solid var(--color-outline-variant)', background: '#fff', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
                <FileText size={14} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-on-surface)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.title}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--color-outline)', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{a.kind}</span>
                    {a.stageKey && <span>· {a.stageKey}</span>}
                    {a.consumableId && <span>· consumable v{a.consumableVersion ?? '?'} {a.consumableStatus ?? ''}</span>}
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
              </div>
              {open && (
                <div style={{ padding: '12px 14px', borderTop: '1px solid var(--color-outline-variant)', background: '#fafafa', maxHeight: 480, overflow: 'auto' }}>
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
    </section>
  )
}
