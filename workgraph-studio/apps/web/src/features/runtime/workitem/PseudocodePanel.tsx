import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { MarkdownView } from '../MarkdownView'
import { cardStyle, primaryButtonStyle, inputStyle, mutedText, sectionTitle, badgeStyle } from './workspaceStyles'
import { errText } from './errText'

/**
 * Spec Studio — pseudo-code / reference implementations. Lists the stored modules (rendered with
 * the dependency-free MarkdownView, which already handles fenced code) and, for editable drafts,
 * generates a new module from the spec's requirements via the LLM. Persists server-side, then the
 * parent refetches.
 */

const LANGUAGES = ['pseudocode', 'typescript', 'python', 'java', 'go', 'sql']

export function PseudocodePanel({ workItemId, versionId, editable, modules, requirements, onChanged }: {
  workItemId: string
  versionId: string
  editable: boolean
  modules: any[]
  requirements: any[]
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [language, setLanguage] = useState('pseudocode')
  const [title, setTitle] = useState('')
  const [scope, setScope] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const genMut = useMutation({
    mutationFn: () => api.post(`/work-items/${workItemId}/specifications/${versionId}/pseudocode/generate`, {
      language,
      title: title.trim() || undefined,
      requirementIds: scope.length ? scope : undefined,
    }).then((r) => r.data),
    onSuccess: () => { setOpen(false); setTitle(''); setScope([]); setError(null); onChanged() },
    onError: (e) => setError(errText(e)),
  })

  const toggleReq = (id: string) => setScope((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <div>
      {error && <div style={{ ...cardStyle, background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 }}>{error}</div>}

      <section style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <h4 style={{ ...sectionTitle, fontSize: 14, marginBottom: 4 }}>Pseudo-code & reference implementations</h4>
            <span style={mutedText}>Sketch how requirements are realized. Generate a starting point, then refine.</span>
          </div>
          {editable && (
            <button style={primaryButtonStyle} onClick={() => { setOpen((o) => !o); setError(null) }}>
              {open ? 'Cancel' : 'Generate module'}
            </button>
          )}
        </div>

        {open && (
          <div style={{ marginTop: 12, display: 'grid', gap: 10, maxWidth: 640 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={mutedText}>Language</span>
                <select style={{ ...inputStyle, width: 160 }} value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 200 }}>
                <span style={mutedText}>Module title (optional)</span>
                <input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Signed link issuance" />
              </label>
            </div>
            {requirements.length > 0 && (
              <div>
                <span style={mutedText}>Scope to requirements (optional — defaults to all):</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {requirements.map((r) => (
                    <button key={r.id} onClick={() => toggleReq(r.id)} style={{
                      padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                      border: scope.includes(r.id) ? '1px solid #368727' : '1px solid var(--color-outline-variant)',
                      background: scope.includes(r.id) ? 'var(--color-primary-dim)' : 'var(--color-surface-bright)',
                      color: scope.includes(r.id) ? 'var(--color-primary-dark)' : 'var(--color-on-surface)',
                    }}>{r.id}</button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <button style={primaryButtonStyle} disabled={genMut.isPending} onClick={() => { setError(null); genMut.mutate() }}>
                {genMut.isPending ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </div>
        )}
      </section>

      {modules.length === 0 ? (
        <section style={cardStyle}><p style={mutedText}>No pseudo-code modules yet.</p></section>
      ) : (
        modules.map((m, i) => (
          <section key={m.id ?? i} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 0 }}>{m.title || m.id}</h4>
              <span style={badgeStyle('spec', 'DRAFT')}>{m.language}</span>
              {m.generated && <span style={{ ...mutedText, fontStyle: 'italic' }}>AI-generated</span>}
              {(m.requirementIds ?? []).length > 0 && <span style={mutedText}>realizes {(m.requirementIds ?? []).join(', ')}</span>}
            </div>
            <MarkdownView source={/```/.test(String(m.content ?? '')) ? String(m.content) : '```' + (m.language || '') + '\n' + String(m.content ?? '') + '\n```'} />
          </section>
        ))
      )}
    </div>
  )
}
