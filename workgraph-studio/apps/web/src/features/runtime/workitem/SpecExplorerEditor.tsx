import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { MarkdownView } from '../MarkdownView'
import { SpecificationEditor } from './SpecificationEditor'
import { DiagramCanvas, type DiagramModel } from './DiagramCanvas'
import { errText } from './errText'
import { requirementDiagnostics, worstSeverity, severityColor, type Diagnostic } from './specDiagnostics'
import { InheritedFromProject } from './InheritedFromProject'

/**
 * Spec explorer + editor — the IDE's Specification view (Phase B). A tree of the spec's parts
 * (requirements as "files", with problem dots), tabs, and an editor that renders a requirement as a
 * syntax-highlighted document with inline diagnostics + code-lens. Structured edits reuse
 * SpecificationEditor; diagrams reuse DiagramCanvas; pseudo-code renders via MarkdownView.
 */

type ItemKind = 'overview' | 'requirement' | 'acceptance' | 'test' | 'diagram' | 'pseudocode'
interface Item { kind: ItemKind; id?: string; label: string }
const HEADER_KEYS = new Set(['schemaVersion', 'workItem', 'version'])

const ide = (v: string) => `var(--ide-${v})`
const mono: CSSProperties = { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }
const kw: CSSProperties = { ...mono, color: 'var(--color-primary)' }
const val: CSSProperties = { ...mono, color: 'var(--color-on-surface)' }
const str: CSSProperties = { ...mono, color: 'var(--color-warning)' }

export function SpecExplorerEditor({ workItemId }: { workItemId: string }) {
  const qc = useQueryClient()
  const [selVersion, setSelVersion] = useState<string | null>(null)
  const [active, setActive] = useState<Item>({ kind: 'overview', label: 'Overview' })
  const [tabs, setTabs] = useState<Item[]>([{ kind: 'overview', label: 'Overview' }])
  const [editing, setEditing] = useState(false)
  const [validation, setValidation] = useState<any | null>(null)
  const [error, setError] = useState<string | null>(null)

  const listQ = useQuery<any>({ queryKey: ['spec-versions', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/specifications`).then((r) => r.data) })
  const versions = listQ.data?.items ?? []
  const currentId = selVersion ?? listQ.data?.activeVersionId ?? versions[0]?.id ?? null
  const versionQ = useQuery<any>({ queryKey: ['spec-version', workItemId, currentId], enabled: !!currentId, queryFn: () => api.get(`/work-items/${workItemId}/specifications/${currentId}`).then((r) => r.data) })
  const pkg = versionQ.data
  const header = pkg?.version ?? {}
  const editable = header.status === 'DRAFT' || header.status === 'CHANGES_REQUESTED'
  const body = useMemo(() => { const b: any = {}; if (pkg) for (const [k, v] of Object.entries(pkg)) if (!HEADER_KEYS.has(k)) b[k] = v; return b }, [pkg])

  const refetch = () => { qc.invalidateQueries({ queryKey: ['spec-versions', workItemId] }); qc.invalidateQueries({ queryKey: ['spec-version', workItemId] }) }
  const createMut = useMutation({ mutationFn: () => api.post(`/work-items/${workItemId}/specifications`, {}).then((r) => r.data), onSuccess: (d: any) => { setSelVersion(d?.version?.id ?? null); setActive({ kind: 'overview', label: 'Overview' }); refetch() }, onError: (e) => setError(errText(e)) })
  const saveMut = useMutation({ mutationFn: (b: any) => api.patch(`/work-items/${workItemId}/specifications/${currentId}`, { ...b, expectedRevision: header.revision ?? 1 }).then((r) => r.data), onSuccess: () => { setEditing(false); setValidation(null); refetch() }, onError: (e) => setError(errText(e)) })
  const validateMut = useMutation({ mutationFn: () => api.post(`/work-items/${workItemId}/specifications/${currentId}/validate`).then((r) => r.data), onSuccess: (d) => { setValidation(d); setError(null) }, onError: (e) => setError(errText(e)) })
  const approveMut = useMutation({ mutationFn: () => api.post(`/work-items/${workItemId}/specifications/${currentId}/approve`, {}).then((r) => r.data), onSuccess: () => { setValidation(null); refetch() }, onError: (e) => setError(errText(e)) })

  const open = (item: Item) => { setActive(item); setEditing(false); setTabs((t) => (t.some((x) => x.kind === item.kind && x.id === item.id) ? t : [...t, item])) }
  const closeTab = (item: Item) => setTabs((t) => { const nx = t.filter((x) => !(x.kind === item.kind && x.id === item.id)); if (active.kind === item.kind && active.id === item.id && nx.length) setActive(nx[nx.length - 1]); return nx })

  const requirements: any[] = body.requirements ?? []
  const diagsByReq = useMemo(() => new Map(requirements.map((r) => [r.id, requirementDiagnostics(r, body)])), [requirements, body])
  const activeReq = active.kind === 'requirement' ? requirements.find((r) => r.id === active.id) : null

  if (!pkg && !listQ.isLoading) {
    return <section style={{ padding: 20, color: 'var(--color-outline)', fontSize: 13 }}>No specification yet. <button style={btn} onClick={() => createMut.mutate()}>Create a draft</button></section>
  }

  return (
    <div style={{ display: 'flex', gap: 0, height: '100%', minHeight: 480, border: `1px solid ${ide('line')}`, borderRadius: 12, overflow: 'hidden', background: ide('editor') }}>
      {/* Explorer */}
      <aside style={{ width: 232, flex: 'none', background: ide('chrome'), borderRight: `1px solid ${ide('line')}`, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 10, borderBottom: `1px solid ${ide('line-soft')}`, display: 'flex', gap: 6 }}>
          <select value={currentId ?? ''} onChange={(e) => { setSelVersion(e.target.value); setActive({ kind: 'overview', label: 'Overview' }) }} style={{ ...selStyle, flex: 1 }}>
            {versions.map((v: any) => <option key={v.id} value={v.id}>v{v.version} · {v.status}</option>)}
          </select>
          <button style={{ ...btn, padding: '4px 8px' }} title="New draft" onClick={() => createMut.mutate()}>+</button>
        </div>
        <div style={{ padding: '6px 6px 20px', fontSize: 12.5 }}>
          <Row on={active.kind === 'overview'} onClick={() => open({ kind: 'overview', label: 'Overview' })}><FileIcon /> Overview</Row>
          <Group label={`Requirements · ${requirements.length}`} />
          {requirements.map((r) => {
            const sev = worstSeverity(diagsByReq.get(r.id) ?? [])
            return (
              <Row key={r.id} indent on={active.kind === 'requirement' && active.id === r.id} onClick={() => open({ kind: 'requirement', id: r.id, label: r.id })}>
                <ReqIcon />
                <span style={{ ...mono, color: 'var(--color-primary)', fontSize: 11.5 }}>{r.id}</span>
                {sev && <span style={{ width: 7, height: 7, borderRadius: 999, background: severityColor(sev), marginLeft: 'auto', flex: 'none' }} />}
                <span style={{ ...priChip(r.priority), marginLeft: sev ? 6 : 'auto' }}>{(r.priority ?? 'S')[0]}</span>
              </Row>
            )
          })}
          <TreeList label="Acceptance criteria" items={(body.acceptanceCriteria ?? [])} kind="acceptance" active={active} open={open} />
          <TreeList label="Test obligations" items={(body.testObligations ?? [])} kind="test" active={active} open={open} />
          <TreeList label="Diagrams" items={(body.diagrams ?? []).map((d: any) => ({ id: d.id, label: d.title || d.id }))} kind="diagram" active={active} open={open} icon={<DiagIcon />} />
          <TreeList label="Pseudo-code" items={(body.pseudocode ?? []).map((p: any) => ({ id: p.id, label: p.title || p.id }))} kind="pseudocode" active={active} open={open} icon={<CodeIcon />} />
        </div>
      </aside>

      {/* Editor */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ display: 'flex', background: ide('chrome'), borderBottom: `1px solid ${ide('line')}`, minHeight: 36 }}>
          {tabs.map((t) => {
            const on = active.kind === t.kind && active.id === t.id
            return (
              <div key={`${t.kind}:${t.id ?? ''}`} onClick={() => setActive(t)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px', fontSize: 12, cursor: 'pointer', color: on ? 'var(--color-on-surface)' : ide('muted'), background: on ? ide('editor') : 'transparent', borderRight: `1px solid ${ide('line')}`, borderTop: on ? '2px solid var(--color-primary)' : '2px solid transparent' }}>
                <span style={mono}>{t.label}</span>
                {tabs.length > 1 && <span onClick={(e) => { e.stopPropagation(); closeTab(t) }} style={{ color: ide('faint'), fontSize: 15 }}>×</span>}
              </div>
            )
          })}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', padding: '0 10px' }}>
            {editable && <button style={btn} onClick={() => validateMut.mutate()}>{validateMut.isPending ? 'Validating…' : 'Validate'}</button>}
            {editable && <button style={btn} onClick={() => setEditing((e) => !e)}>{editing ? 'Close editor' : 'Edit'}</button>}
            {editable && <button style={{ ...btn, background: 'var(--color-primary)', color: '#fff', borderColor: 'var(--color-primary)' }} onClick={() => approveMut.mutate()}>{approveMut.isPending ? 'Approving…' : 'Approve'}</button>}
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {error && <div style={{ margin: 12, padding: 10, borderRadius: 8, background: 'var(--color-danger)', color: '#fff', fontSize: 12 }}>{error}</div>}
          {validation && <ValidationStrip v={validation} />}

          {editing ? (
            <div style={{ padding: 16 }}><SpecificationEditor initialBody={body} revision={header.revision ?? 1} saving={saveMut.isPending} onSave={(b) => saveMut.mutate(b)} onCancel={() => setEditing(false)} /></div>
          ) : active.kind === 'overview' ? (
            <div>
              <div style={{ padding: '16px 16px 0' }}><InheritedFromProject workItemId={workItemId} section="requirements" /></div>
              <OverviewDoc pkg={pkg} reqCount={requirements.length} problems={[...diagsByReq.values()].flat()} />
            </div>
          ) : activeReq ? (
            <RequirementDoc req={activeReq} diags={diagsByReq.get(activeReq.id) ?? []} onEdit={() => setEditing(true)} editable={editable} />
          ) : active.kind === 'diagram' ? (
            <div style={{ padding: 16 }}><DiagramCanvas diagram={((body.diagrams ?? []).find((d: any) => d.id === active.id) ?? { id: '', nodes: [], edges: [] }) as DiagramModel} /></div>
          ) : active.kind === 'pseudocode' ? (
            <div style={{ padding: 16 }}>{(() => { const m = (body.pseudocode ?? []).find((p: any) => p.id === active.id); return m ? <MarkdownView source={/```/.test(String(m.content ?? '')) ? String(m.content) : '```' + (m.language || '') + '\n' + String(m.content ?? '') + '\n```'} /> : <Empty>Not found.</Empty> })()}</div>
          ) : (
            <RecordDoc record={((active.kind === 'acceptance' ? body.acceptanceCriteria : body.testObligations) ?? []).find((x: any) => x.id === active.id)} />
          )}
        </div>
      </div>
    </div>
  )
}

function RequirementDoc({ req, diags, onEdit, editable }: { req: any; diags: Diagnostic[]; onEdit: () => void; editable: boolean }) {
  const lines: ReactNode[] = []
  const p = (jsx: ReactNode) => lines.push(jsx)
  p(<><span style={kw}>id</span><span style={val}>:        {req.id}</span></>)
  p(<><span style={kw}>type</span><span style={val}>:      {req.type ?? 'FUNCTIONAL'}</span></>)
  p(<><span style={kw}>priority</span><span style={val}>:  {req.priority ?? 'SHOULD'}    </span><span style={kw}>risk</span><span style={val}>: {req.risk ?? 'MEDIUM'}</span></>)
  p(<><span style={kw}>statement</span><span style={str}>: |</span></>)
  for (const ln of String(req.statement ?? '').split('\n')) p(<span style={{ ...str, paddingLeft: 16 }}>{ln}</span>)
  p(<span> </span>)
  p(<><span style={kw}>acceptance</span><span style={val}>: [{(req.acceptanceCriterionIds ?? []).join(', ') || '—'}]</span></>)
  p(<><span style={kw}>tests</span><span style={val}>:     [{(req.testObligationIds ?? []).join(', ') || <span style={{ textDecoration: 'wavy underline var(--color-warning)', textUnderlineOffset: 3 }}>none</span>}]</span></>)
  p(<><span style={kw}>sources</span><span style={val}>:   [{(req.sourceIds ?? []).join(', ') || '—'}]</span></>)
  return (
    <div style={{ padding: '10px 0' }}>
      {lines.map((jsx, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '44px 1fr' }}>
          <span style={{ ...mono, textAlign: 'right', paddingRight: 16, color: ide('faint'), fontSize: 12, userSelect: 'none' }}>{i + 1}</span>
          <span style={{ ...mono, fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{jsx}</span>
        </div>
      ))}
      {diags.map((d, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '44px 1fr', marginTop: 2 }}>
          <span />
          <span style={{ margin: '2px 16px 2px 0', padding: '3px 10px', borderRadius: 6, fontSize: 11.5, background: d.severity === 'error' ? 'var(--color-danger)' : d.severity === 'warning' ? 'var(--color-warning)' : 'var(--color-secondary)', color: '#fff', display: 'inline-flex', width: 'fit-content' }}>{d.severity === 'error' ? '✕' : d.severity === 'warning' ? '!' : 'i'} {d.message}</span>
        </div>
      ))}
      {editable && <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr', marginTop: 4 }}><span /><span style={{ fontSize: 11.5, color: ide('faint') }}><b style={{ color: 'var(--color-primary)', cursor: 'pointer' }} onClick={onEdit}>✎ Edit requirement</b></span></div>}
    </div>
  )
}

function RecordDoc({ record }: { record: any }) {
  if (!record) return <Empty>Not found.</Empty>
  return <pre style={{ ...mono, margin: 0, padding: 18, fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-on-surface)', whiteSpace: 'pre-wrap' }}>{JSON.stringify(record, null, 2)}</pre>
}

function OverviewDoc({ pkg, reqCount, problems }: { pkg: any; reqCount: number; problems: Diagnostic[] }) {
  const errs = problems.filter((p) => p.severity === 'error').length
  const warns = problems.filter((p) => p.severity === 'warning').length
  return (
    <div style={{ padding: 20 }}>
      <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: ide('faint'), fontWeight: 700, ...mono }}>{pkg?.version?.status}</div>
      <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface)', maxWidth: '64ch' }}>{pkg?.summary || 'No summary yet.'}</p>
      <div style={{ display: 'flex', gap: 18, marginTop: 14, fontSize: 12.5, color: 'var(--color-outline)' }}>
        <span><b style={{ color: 'var(--color-on-surface)', fontSize: 15 }}>{reqCount}</b> requirements</span>
        <span><b style={{ color: errs ? 'var(--color-danger)' : 'var(--color-on-surface)', fontSize: 15 }}>{errs}</b> problems</span>
        <span><b style={{ color: warns ? 'var(--color-warning)' : 'var(--color-on-surface)', fontSize: 15 }}>{warns}</b> warnings</span>
      </div>
    </div>
  )
}

function ValidationStrip({ v }: { v: any }) {
  return <div style={{ margin: 12, padding: '8px 12px', borderRadius: 8, border: `1px solid ${ide('line')}`, fontSize: 12, color: 'var(--color-on-surface)' }}>Validation: <b style={{ color: v.passed ? 'var(--color-success)' : 'var(--color-danger)' }}>{v.passed ? 'passed' : 'blocked'}</b> · {v.errorCount} errors · {v.warningCount} warnings</div>
}

// ── bits ──────────────────────────────────────────────────────────────────────
const btn: CSSProperties = { fontSize: 12, fontWeight: 600, padding: '5px 11px', borderRadius: 7, border: `1px solid ${ide('line')}`, background: 'transparent', color: 'var(--color-on-surface)', cursor: 'pointer' }
const selStyle: CSSProperties = { fontSize: 12, padding: '5px 7px', borderRadius: 7, border: `1px solid ${ide('line')}`, background: ide('editor'), color: 'var(--color-on-surface)' }
function priChip(p?: string): CSSProperties { const t = p === 'MUST' ? 'var(--color-danger)' : p === 'SHOULD' ? 'var(--color-secondary)' : 'var(--color-outline)'; return { ...mono, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4, color: t, border: `1px solid ${t}`, flex: 'none' } }
function Row({ children, on, indent, onClick }: { children: ReactNode; on?: boolean; indent?: boolean; onClick: () => void }) {
  return <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', paddingLeft: indent ? 22 : 8, borderRadius: 6, cursor: 'pointer', color: on ? 'var(--color-primary-dark)' : 'var(--color-on-surface)', background: on ? 'var(--color-primary-dim)' : 'transparent', whiteSpace: 'nowrap' }}>{children}</div>
}
function Group({ label }: { label: string }) { return <div style={{ ...mono, padding: '10px 8px 3px', fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: ide('faint'), fontWeight: 600 }}>{label}</div> }
function TreeList({ label, items, kind, active, open, icon }: { label: string; items: any[]; kind: ItemKind; active: Item; open: (i: Item) => void; icon?: ReactNode }) {
  if (!items.length) return null
  return (<><Group label={`${label} · ${items.length}`} />{items.map((it) => (
    <Row key={it.id} indent on={active.kind === kind && active.id === it.id} onClick={() => open({ kind, id: it.id, label: it.label || it.id })}>{icon ?? <DotIcon />}<span style={{ ...mono, fontSize: 11.5, color: 'var(--color-primary)' }}>{it.id}</span>{it.label && it.label !== it.id && <span style={{ color: 'var(--color-outline)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.label}</span>}</Row>
  ))}</>)
}
function Empty({ children }: { children: ReactNode }) { return <div style={{ padding: 20, color: 'var(--color-outline)', fontSize: 13 }}>{children}</div> }
const iconStyle = { width: 14, height: 14, flex: 'none' as const, color: 'var(--color-outline)' }
function FileIcon() { return <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 4h11l5 5v11H4z" /><path d="M14 4v6h6" /></svg> }
function ReqIcon() { return <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 6h16M4 12h16M4 18h11" /></svg> }
function DiagIcon() { return <svg style={{ ...iconStyle, color: 'var(--color-secondary)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><path d="M10 6.5h4a3 3 0 0 1 3 3V14" /></svg> }
function CodeIcon() { return <svg style={{ ...iconStyle, color: 'var(--color-warning)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M8 9l-2 3 2 3M16 9l2 3-2 3" /></svg> }
function DotIcon() { return <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="3" /></svg> }
