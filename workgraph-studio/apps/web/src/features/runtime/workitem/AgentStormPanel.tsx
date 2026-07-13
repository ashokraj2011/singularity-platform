import { useState, type CSSProperties } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { errText } from './errText'

/**
 * Agent Storm — the IDE's AI assistant panel. v1 drives real spec authoring: a prompt in the
 * Specification view generates a draft via the existing /specifications/generate endpoint. Full
 * conversational, multi-turn authoring with in-place "apply" actions is Phase C (a converse
 * endpoint). Honest about the model bridge: if Context Fabric's bridge is offline the send surfaces
 * the exact error rather than faking a reply.
 */

const wrap: CSSProperties = { width: 348, flex: 'none', borderLeft: '1px solid var(--ide-line)', background: 'var(--ide-chrome)', display: 'flex', flexDirection: 'column', minHeight: 0 }
const capItem: CSSProperties = { display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--ide-ink-dim)', lineHeight: 1.5 }

export function AgentStormPanel({ workItemId, view, onClose }: { workItemId: string; view: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [prompt, setPrompt] = useState('')
  const [log, setLog] = useState<{ role: 'user' | 'agent'; text: string }[]>([])

  const genMut = useMutation({
    mutationFn: (p: string) => api.post(`/work-items/${workItemId}/specifications/generate`, { prompt: p }).then((r) => r.data),
    onSuccess: (d: any) => {
      setLog((l) => [...l, { role: 'agent', text: `Drafted specification v${d?.specification?.version?.number ?? ''}${d?.repaired ? ' (auto-repaired a blocking issue)' : ''}. Review it in the editor.` }])
      qc.invalidateQueries({ queryKey: ['spec-versions', workItemId] })
      qc.invalidateQueries({ queryKey: ['spec-version', workItemId] })
    },
    onError: (e) => setLog((l) => [...l, { role: 'agent', text: `Couldn't reach the model: ${errText(e)}` }]),
  })

  const send = () => {
    const p = prompt.trim()
    if (!p) return
    setLog((l) => [...l, { role: 'user', text: p }])
    setPrompt('')
    if (view === 'specification' || view === 'overview') genMut.mutate(p)
    else setLog((l) => [...l, { role: 'agent', text: 'Agent Storm authors specifications — switch to the Specification view and I\'ll draft one from your prompt.' }])
  }

  return (
    <aside style={wrap}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--ide-line)', display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ width: 24, height: 24, borderRadius: 7, background: 'var(--ide-accent-soft)', color: 'var(--ide-accent)', display: 'grid', placeItems: 'center' }}>
          <Bolt />
        </span>
        <b style={{ fontSize: 13, fontWeight: 750, letterSpacing: '-.01em', color: 'var(--ide-ink)' }}>Agent Storm</b>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono, ui-monospace)', fontSize: 10, color: 'var(--ide-muted)', border: '1px solid var(--ide-line)', borderRadius: 6, padding: '2px 7px' }}>claude · spec</span>
        <button onClick={onClose} title="Hide" style={{ border: 'none', background: 'none', color: 'var(--ide-faint)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {log.length === 0 ? (
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ fontSize: 12.5, color: 'var(--ide-ink-dim)', lineHeight: 1.55 }}>Draft and refine this Work Item's specification in natural language.</div>
            <div style={capItem}><Dot /> Describe what to build → a versioned draft with requirements, acceptance criteria and test obligations.</div>
            <div style={capItem}><Dot /> Attach a PRD or ticket for grounding.</div>
            <div style={capItem}><Dot /> Ask for diagrams or reference pseudo-code.</div>
            <div style={{ fontSize: 11.5, color: 'var(--ide-faint)', lineHeight: 1.5, borderTop: '1px solid var(--ide-line-soft)', paddingTop: 12 }}>
              In-place, multi-turn editing with "apply" actions arrives next. Generation needs the platform's model bridge.
            </div>
          </div>
        ) : (
          log.map((m, i) => (
            m.role === 'user' ? (
              <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '88%', background: 'var(--ide-accent-soft)', color: 'var(--color-primary-dark)', border: '1px solid var(--color-primary-dim)', padding: '9px 12px', borderRadius: '12px 12px 3px 12px', fontSize: 12.5, lineHeight: 1.5 }}>{m.text}</div>
            ) : (
              <div key={i} style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--ide-ink-dim)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}><span style={{ width: 18, height: 18, borderRadius: 5, background: 'var(--ide-accent-soft)', color: 'var(--ide-accent)', display: 'grid', placeItems: 'center' }}><Bolt small /></span><b style={{ color: 'var(--ide-ink)', fontSize: 11.5 }}>Agent Storm</b></div>
                {m.text}
              </div>
            )
          ))
        )}
        {genMut.isPending && <div style={{ fontSize: 12, color: 'var(--ide-muted)', fontStyle: 'italic' }}>Agent Storm is drafting…</div>}
      </div>

      <div style={{ padding: 12, borderTop: '1px solid var(--ide-line)' }}>
        <div style={{ border: '1px solid var(--ide-line)', borderRadius: 11, background: 'var(--ide-editor)', padding: '10px 12px' }}>
          <textarea
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
            placeholder="Ask Agent Storm to draft the spec, add tests, or sketch a diagram…"
            style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--ide-ink)', fontFamily: 'inherit', fontSize: 12.5, resize: 'none', outline: 'none' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: 10.5, color: 'var(--ide-muted)', border: '1px solid var(--ide-line)', borderRadius: 6, padding: '3px 8px' }}>@ {view}</span>
            <button onClick={send} disabled={genMut.isPending || !prompt.trim()} style={{ marginLeft: 'auto', width: 30, height: 30, borderRadius: 8, background: 'var(--ide-accent)', color: 'var(--ide-accent-ink)', border: 'none', display: 'grid', placeItems: 'center', cursor: 'pointer', opacity: genMut.isPending || !prompt.trim() ? 0.5 : 1 }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

function Bolt({ small }: { small?: boolean }) {
  const s = small ? 11 : 14
  return <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2 4.5 13H11l-1 9 8.5-11H12z" /></svg>
}
function Dot() {
  return <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--ide-accent)', marginTop: 6, flex: 'none' }} />
}
