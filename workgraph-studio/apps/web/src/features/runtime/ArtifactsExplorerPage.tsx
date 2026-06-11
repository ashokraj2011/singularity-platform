/**
 * Artifacts — global browser for every artifact the current user's runs have
 * produced, newest first. Top-level nav entry. Each row deep-links back to its
 * owning run (when the artifact's session is attached to a workflow instance).
 * Per-run artifacts also live at /runs/:id/artifacts; this is the cross-run view.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { FileText, Download, Package, ExternalLink } from 'lucide-react'
import { api } from '../../lib/api'
import { unwrapList } from '../../lib/unwrap'
import { MarkdownView } from './MarkdownView'

type GlobalArtifact = {
  id: string
  sessionId: string
  sessionGoal?: string | null
  workflowInstanceId?: string | null
  workflowName?: string | null
  workflowStatus?: string | null
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

type Response = { count: number; items: GlobalArtifact[] }

function artifactBody(a: GlobalArtifact): string {
  if (typeof a.content === 'string' && a.content.length > 0) return a.content
  if (a.payload && Object.keys(a.payload).length > 0) return JSON.stringify(a.payload, null, 2)
  return ''
}

function download(a: GlobalArtifact) {
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

const WORKFLOW_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED']

type Facets = {
  workItems: { id: string; workCode: string; title: string; status: string }[]
  instances: { id: string; name: string; status: string }[]
  statuses: string[]
}

export function ArtifactsExplorerPage() {
  const navigate = useNavigate()
  const [openId, setOpenId] = useState<string | null>(null)
  const [kind, setKind] = useState<string>('')
  // Server-side filters, now dropdown-selected (work-item id, instance id,
  // status enum) rather than free text.
  const [workItem, setWorkItem] = useState<string>('')
  const [workflowInstanceId, setWorkflowInstanceId] = useState<string>('')
  const [workflowStatus, setWorkflowStatus] = useState<string>('')

  // Auto-populate the work-item / instance dropdowns from the work that
  // actually has artifacts (scoped to this user, server-side).
  const { data: facets } = useQuery<Facets>({
    queryKey: ['artifacts-facets'],
    queryFn: () => api.get('/blueprint/artifacts/facets').then(r => r.data),
  })

  const params = useMemo(() => {
    const p: Record<string, string> = {}
    if (kind) p.kind = kind
    if (workItem) p.workItemId = workItem
    if (workflowInstanceId) p.workflowInstanceId = workflowInstanceId
    if (workflowStatus) p.workflowStatus = workflowStatus
    return p
  }, [kind, workItem, workflowInstanceId, workflowStatus])

  const { data, isLoading, isError, error } = useQuery<Response>({
    queryKey: ['artifacts-global', params],
    queryFn: () => api.get('/blueprint/artifacts', { params }).then(r => r.data),
  })

  // Workflow-run artifacts (the per-file consumables) — merged in so the explorer
  // shows BOTH workbench (blueprint) and workflow artifacts. /consumables paginates
  // under `content`.
  type WfConsumable = { id: string; name?: string; status?: string; instanceId?: string; createdAt?: string; formData?: { content?: string } }
  const { data: wfData } = useQuery<{ content?: WfConsumable[] } | WfConsumable[]>({
    queryKey: ['artifacts-workflow-consumables'],
    queryFn: () => api.get('/consumables', { params: { size: 200 } }).then(r => r.data),
  })

  const items = useMemo(() => {
    const blueprint = data?.items ?? []
    const raw = unwrapList<WfConsumable>(wfData)
    const workflow = raw
      .filter(c => typeof c.formData?.content === 'string' && (c.formData!.content as string).length > 0)
      .filter(c => !workflowInstanceId || c.instanceId === workflowInstanceId)
      .map(c => ({
        id: c.id, title: c.name ?? 'Artifact', kind: 'WORKFLOW',
        createdAt: c.createdAt ?? '', workflowInstanceId: c.instanceId,
        workflowStatus: c.status, content: c.formData?.content ?? '',
      }))
    return [...blueprint, ...(workflow as unknown as typeof blueprint)]
  }, [data, wfData, workflowInstanceId])

  // Run filter options: facets (blueprint) + every run that has a workflow artifact,
  // so the dropdown populates even with no workbench data.
  const runOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of (facets?.instances ?? [])) m.set(i.id, `${i.name} · ${i.status}`)
    const raw = unwrapList<WfConsumable>(wfData)
    for (const c of raw) { if (c.instanceId && !m.has(c.instanceId)) m.set(c.instanceId, `Run ${c.instanceId.slice(0, 8)}`) }
    return Array.from(m, ([id, label]) => ({ id, label }))
  }, [facets, wfData])
  const kinds = useMemo(() => Array.from(new Set(items.map(i => i.kind))).sort(), [items])
  const statusOptions = facets?.statuses ?? WORKFLOW_STATUSES
  const inputStyle: React.CSSProperties = { fontSize: 12, padding: '5px 8px', borderRadius: 7, border: '1px solid var(--color-outline-variant)', background: '#fff', color: 'var(--color-on-surface)', maxWidth: 260 }

  return (
    <div style={{ padding: 24, maxWidth: 920, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 9,
          background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.28)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d97706', flexShrink: 0,
        }}>
          <Package size={16} />
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-on-surface)', letterSpacing: '-0.01em' }}>
            Artifacts
          </h1>
          <p style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 2 }}>
            {isLoading ? 'Loading…' : `${items.length} artifact${items.length === 1 ? '' : 's'} across your workbench + workflow runs`}
          </p>
        </div>
      </div>

      {/* Filters auto-populated from the work that actually has artifacts
          (GET /artifacts/facets): work item, workflow instance, status, kind. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
        <select value={workItem} onChange={e => setWorkItem(e.target.value)} style={inputStyle} title="Filter by work item">
          <option value="">All work items</option>
          {(facets?.workItems ?? []).map(w => (
            <option key={w.id} value={w.id}>{w.workCode} · {w.title}</option>
          ))}
        </select>
        <select value={workflowInstanceId} onChange={e => setWorkflowInstanceId(e.target.value)} style={inputStyle} title="Filter by workflow run">
          <option value="">All workflow runs</option>
          {runOptions.map(r => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
        <select value={workflowStatus} onChange={e => setWorkflowStatus(e.target.value)} style={inputStyle}>
          <option value="">Any status</option>
          {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {kinds.length > 0 && (
          <select value={kind} onChange={e => setKind(e.target.value)} style={inputStyle}>
            <option value="">All kinds</option>
            {kinds.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        )}
        {(workItem || workflowInstanceId || workflowStatus || kind) && (
          <button
            onClick={() => { setWorkItem(''); setWorkflowInstanceId(''); setWorkflowStatus(''); setKind('') }}
            style={{ fontSize: 11, fontWeight: 600, padding: '5px 9px', borderRadius: 7, border: '1px solid var(--color-outline-variant)', background: 'transparent', cursor: 'pointer', color: 'var(--color-outline)' }}
          >
            Clear
          </button>
        )}
      </div>

      {isError && (
        <p style={{ padding: 16, color: '#ef4444', fontSize: 13 }}>
          Could not load artifacts: {(error as Error)?.message ?? 'unknown error'}
        </p>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <p style={{ padding: 24, color: 'var(--color-outline)', fontSize: 13, textAlign: 'center' }}>
          No artifacts yet. They appear here once a run produces them.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map(a => {
          const open = openId === a.id
          const body = artifactBody(a)
          return (
            <div key={a.id} style={{ borderRadius: 10, border: '1px solid var(--color-outline-variant)', background: '#fff', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px' }}>
                <FileText size={15} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.title}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--color-outline)', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{a.kind}</span>
                    {a.stageKey && <span>· {a.stageKey}</span>}
                    {a.workflowStatus && <span title={a.workflowName ?? undefined} style={{ fontWeight: 700 }}>· {a.workflowStatus}</span>}
                    {a.sessionGoal && <span title={a.sessionGoal} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {a.sessionGoal}</span>}
                    <span>· {new Date(a.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                {a.workflowInstanceId && (
                  <button
                    onClick={() => navigate(`/runs/${a.workflowInstanceId}/artifacts`)}
                    title="Open the run this artifact belongs to"
                    style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, padding: '4px 9px', borderRadius: 6, border: '1px solid var(--color-outline-variant)', background: 'transparent', cursor: 'pointer', color: 'var(--color-outline)' }}
                  >
                    <ExternalLink size={11} /> Run
                  </button>
                )}
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
    </div>
  )
}
