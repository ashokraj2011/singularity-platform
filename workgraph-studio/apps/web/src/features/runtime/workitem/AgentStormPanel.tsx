import { useState, type CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { errText } from './errText'

/**
 * Agent Storm — the IDE's conversational spec author (Phase C). Multi-turn: it converses about the
 * Work Item's spec and returns applyable proposals (a requirement / acceptance criterion / test),
 * each inserted into the draft in one click. Honest about the model bridge — a send that can't
 * reach the model shows the exact error, not a fake reply.
 */

interface Proposal { kind: 'requirement' | 'acceptance' | 'test'; data: any; label?: string }
interface Msg { role: 'user' | 'assistant'; content: string; proposals?: Proposal[] }

const wrap: CSSProperties = { width: 348, flex: 'none', borderLeft: '1px solid var(--ide-line)', background: 'var(--ide-chrome)', display: 'flex', flexDirection: 'column', minHeight: 0 }

export function AgentStormPanel({ workItemId, view, onClose }: { workItemId: string; view: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [prompt, setPrompt] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [note, setNote] = useState<string | null>(null)

  const specQ = useQuery<any>({ queryKey: ['spec-versions', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/specifications`).then((r) => r.data) })
  const items: any[] = specQ.data?.items ?? []
  const draft = items.find((v) => v.status === 'DRAFT' || v.status === 'CHANGES_REQUESTED')
  const contextVersionId = draft?.id ?? specQ.data?.activeVersionId ?? items[0]?.id ?? undefined

  const refetchSpec = () => { qc.invalidateQueries({ queryKey: ['spec-versions', workItemId] }); qc.invalidateQueries({ queryKey: ['spec-version', workItemId] }) }

  const converseMut = useMutation({
    mutationFn: (history: Msg[]) => api.post(`/work-items/${workItemId}/spec-agent/converse`, { messages: history.map((m) => ({ role: m.role, content: m.content })), versionId: contextVersionId }).then((r) => r.data),
    onSuccess: (d: any) => setMsgs((m) => [...m, { role: 'assistant', content: String(d?.reply ?? ''), proposals: Array.isArray(d?.proposals) ? d.proposals : [] }]),
    onError: (e) => setMsgs((m) => [...m, { role: 'assistant', content: `Couldn't reach the model: ${errText(e)}` }]),
  })

  const applyMut = useMutation({
    mutationFn: async (p: Proposal) => {
      let versionId = draft?.id
      if (!versionId) versionId = (await api.post(`/work-items/${workItemId}/specifications`, {}).then((r) => r.data))?.version?.id
      return api.post(`/work-items/${workItemId}/specifications/${versionId}/apply`, { proposal: p }).then((r) => r.data)
    },
    onSuccess: (_d, p) => { setNote(`Applied ${p.kind} ${p.data?.id ?? ''}.`); refetchSpec() },
    onError: (e) => setNote(errText(e)),
  })

  const send = () => {
    const p = prompt.trim()
    if (!p) return
    const next: Msg[] = [...msgs, { role: 'user', content: p }]
    setMsgs(next); setPrompt(''); setNote(null)
    converseMut.mutate(next)
  }

  return (
    <aside style={wrap}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--ide-line)', display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ width: 24, height: 24, borderRadius: 7, background: 'var(--ide-accent-soft)', color: 'var(--ide-accent)', display: 'grid', placeItems: 'center' }}><Bolt /></span>
        <b style={{ fontSize: 13, fontWeight: 750, letterSpacing: '-.01em', color: 'var(--ide-ink)' }}>Agent Storm</b>
        <span style={{ marginLeft: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 10, color: 'var(--ide-muted)', border: '1px solid var(--ide-line)', borderRadius: 6, padding: '2px 7px' }}>claude · spec</span>
        <button onClick={onClose} title="Hide" style={{ border: 'none', background: 'none', color: 'var(--ide-faint)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {msgs.length === 0 && (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ fontSize: 12.5, color: 'var(--ide-ink-dim)', lineHeight: 1.55 }}>Pair-author this Work Item's specification in natural language. I propose requirements, acceptance criteria and tests you can apply in one click.</div>
            <div style={{ fontSize: 11.5, color: 'var(--ide-faint)', lineHeight: 1.5, borderTop: '1px solid var(--ide-line-soft)', paddingTop: 12 }}>Try: “add a MUST for backpressure with a measurable acceptance criterion,” or “draft a test obligation for REQ-3.” Generation needs the platform's model bridge.</div>
          </div>
        )}
        {msgs.map((m, i) => (
          m.role === 'user' ? (
            <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '88%', background: 'var(--ide-accent-soft)', color: 'var(--color-primary-dark)', border: '1px solid var(--color-primary-dim)', padding: '9px 12px', borderRadius: '12px 12px 3px 12px', fontSize: 12.5, lineHeight: 1.5 }}>{m.content}</div>
          ) : (
            <div key={i}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}><span style={{ width: 18, height: 18, borderRadius: 5, background: 'var(--ide-accent-soft)', color: 'var(--ide-accent)', display: 'grid', placeItems: 'center' }}><Bolt small /></span><b style={{ color: 'var(--ide-ink)', fontSize: 11.5 }}>Agent Storm</b></div>
              <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--ide-ink-dim)' }}>{m.content}</div>
              {(m.proposals ?? []).map((p, j) => (
                <div key={j} style={{ marginTop: 9, border: '1px solid var(--ide-line)', borderRadius: 10, overflow: 'hidden', background: 'var(--ide-editor)' }}>
                  <div style={{ padding: '7px 11px', borderBottom: '1px solid var(--ide-line-soft)', display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--ide-muted)' }}>
                    <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--ide-accent)', fontWeight: 700 }}>{p.kind}</span>{p.label ? ` · ${p.label}` : ''}
                  </div>
                  <pre style={{ margin: 0, padding: '10px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 11, lineHeight: 1.55, color: 'var(--color-on-surface)', whiteSpace: 'pre-wrap', overflowX: 'auto' }}>{summarize(p)}</pre>
                  <div style={{ padding: '8px 11px', borderTop: '1px solid var(--ide-line-soft)' }}>
                    <button disabled={applyMut.isPending} onClick={() => applyMut.mutate(p)} style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 12px', borderRadius: 7, background: 'var(--ide-accent)', color: 'var(--ide-accent-ink)', border: 'none', cursor: 'pointer' }}>{applyMut.isPending ? 'Applying…' : `Insert ${p.data?.id ?? p.kind}`}</button>
                  </div>
                </div>
              ))}
            </div>
          )
        ))}
        {converseMut.isPending && <div style={{ fontSize: 12, color: 'var(--ide-muted)', fontStyle: 'italic' }}>Agent Storm is thinking…</div>}
        {note && <div style={{ fontSize: 11.5, color: 'var(--ide-accent)', background: 'var(--ide-accent-soft)', padding: '6px 10px', borderRadius: 8 }}>{note}</div>}
      </div>

      <div style={{ padding: 12, borderTop: '1px solid var(--ide-line)' }}>
        <div style={{ border: '1px solid var(--ide-line)', borderRadius: 11, background: 'var(--ide-editor)', padding: '10px 12px' }}>
          <textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }} placeholder="Ask Agent Storm to draft, refine, or add tests…" style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--ide-ink)', fontFamily: 'inherit', fontSize: 12.5, resize: 'none', outline: 'none' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: 10.5, color: 'var(--ide-muted)', border: '1px solid var(--ide-line)', borderRadius: 6, padding: '3px 8px' }}>@ {view}</span>
            <button onClick={send} disabled={converseMut.isPending || !prompt.trim()} style={{ marginLeft: 'auto', width: 30, height: 30, borderRadius: 8, background: 'var(--ide-accent)', color: 'var(--ide-accent-ink)', border: 'none', display: 'grid', placeItems: 'center', cursor: 'pointer', opacity: converseMut.isPending || !prompt.trim() ? 0.5 : 1 }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

function summarize(p: Proposal): string {
  const d = p.data ?? {}
  if (p.kind === 'requirement') return `${d.id ?? ''} [${d.priority ?? 'SHOULD'}] ${d.statement ?? ''}`
  if (p.kind === 'acceptance') return `${d.id ?? ''} verifies ${(d.requirementIds ?? []).join(', ')}\n${[...(d.given ?? []), ...(d.when ?? []), ...(d.then ?? [])].join(' / ')}`
  return `${d.id ?? ''} verifies ${(d.verifies ?? []).join(', ')}\n${d.description ?? ''}`
}
function Bolt({ small }: { small?: boolean }) {
  const s = small ? 11 : 14
  return <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2 4.5 13H11l-1 9 8.5-11H12z" /></svg>
}
