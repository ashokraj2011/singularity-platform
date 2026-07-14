import { useMemo, useState, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { cardStyle, primaryButtonStyle, secondaryButtonStyle, inputStyle, mutedText, sectionTitle, badgeStyle } from './workspaceStyles'
import { errText } from './errText'

/**
 * Discussion — the collaboration surface. Threaded comments on the studio with @mentions and
 * resolve, anchored optionally to a spec artifact. Near-live via an 8s poll (SSE push is a
 * follow-up). The shared "work together" layer over the versioned spec.
 */
interface Comment { id: string; body: string; authorId: string; mentions: string[]; parentId: string | null; anchorKind: string | null; anchorId: string | null; resolvedAt: string | null; createdAt: string }

export function CommentsPanel({ workItemId }: { workItemId: string }) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const q = useQuery<{ items: Comment[] }>({ queryKey: ['comments', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/comments`).then((r) => r.data), refetchInterval: 8000 })
  const items = q.data?.items ?? []
  const threads = useMemo(() => {
    const replies = new Map<string, Comment[]>()
    const roots: Comment[] = []
    for (const c of items) { if (c.parentId) { (replies.get(c.parentId) ?? replies.set(c.parentId, []).get(c.parentId)!).push(c) } else roots.push(c) }
    return roots.map((c) => ({ c, replies: replies.get(c.id) ?? [] }))
  }, [items])

  const invalidate = () => qc.invalidateQueries({ queryKey: ['comments', workItemId] })
  const postMut = useMutation({ mutationFn: (input: { body: string; parentId?: string }) => api.post(`/work-items/${workItemId}/comments`, input).then((r) => r.data), onSuccess: () => { setBody(''); setReplyTo(null); invalidate() }, onError: (e) => setError(errText(e)) })
  const resolveMut = useMutation({ mutationFn: (v: { id: string; resolved: boolean }) => api.post(`/work-items/${workItemId}/comments/${v.id}/resolve`, { resolved: v.resolved }).then((r) => r.data), onSuccess: invalidate, onError: (e) => setError(errText(e)) })
  const delMut = useMutation({ mutationFn: (id: string) => api.delete(`/work-items/${workItemId}/comments/${id}`).then((r) => r.data), onSuccess: invalidate, onError: (e) => setError(errText(e)) })

  const post = () => { if (body.trim()) { setError(null); postMut.mutate({ body: body.trim(), parentId: replyTo ?? undefined }) } }

  return (
    <div style={{ maxWidth: 820 }}>
      <section style={{ ...cardStyle, background: 'linear-gradient(180deg, var(--color-surface-bright), var(--color-surface-low))' }}>
        <h3 style={{ ...sectionTitle, marginBottom: 4 }}>Discussion</h3>
        <span style={mutedText}>Comment, @mention a teammate, resolve. Everyone working this spec sees the thread.</span>
      </section>

      {error && <div style={{ ...cardStyle, background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 }}>{error}</div>}

      <section style={cardStyle}>
        <textarea style={{ ...inputStyle, minHeight: 72, resize: 'vertical' }} value={replyTo ? body : body} placeholder={replyTo ? 'Reply…' : 'Start a discussion, or @mention a teammate…'} onChange={(e) => setBody(e.target.value)} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          {replyTo && <span style={mutedText}>replying — <button style={{ ...secondaryButtonStyle, padding: '3px 8px' }} onClick={() => setReplyTo(null)}>cancel</button></span>}
          <button style={{ ...primaryButtonStyle, marginLeft: 'auto' }} disabled={!body.trim() || postMut.isPending} onClick={post}>{postMut.isPending ? 'Posting…' : replyTo ? 'Reply' : 'Comment'}</button>
        </div>
      </section>

      {q.isLoading ? <p style={mutedText}>Loading…</p> : threads.length === 0 ? (
        <section style={cardStyle}><p style={mutedText}>No comments yet. Start the conversation.</p></section>
      ) : threads.map(({ c, replies }) => (
        <section key={c.id} style={{ ...cardStyle, opacity: c.resolvedAt ? 0.65 : 1 }}>
          <CommentView c={c} onResolve={() => resolveMut.mutate({ id: c.id, resolved: !c.resolvedAt })} onReply={() => { setReplyTo(c.id); setBody('') }} onDelete={() => delMut.mutate(c.id)} />
          {replies.length > 0 && (
            <div style={{ marginTop: 10, marginLeft: 14, paddingLeft: 14, borderLeft: '2px solid var(--color-outline-variant)', display: 'grid', gap: 12 }}>
              {replies.map((r) => <CommentView key={r.id} c={r} reply onDelete={() => delMut.mutate(r.id)} />)}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}

function CommentView({ c, reply, onResolve, onReply, onDelete }: { c: Comment; reply?: boolean; onResolve?: () => void; onReply?: () => void; onDelete?: () => void }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
        <span style={{ width: 22, height: 22, borderRadius: 999, background: 'var(--color-primary)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 700 }}>{initials(c.authorId)}</span>
        <strong style={{ fontSize: 12.5, color: 'var(--color-on-surface)' }}>{c.authorId}</strong>
        {c.anchorId && !reply && <span style={badgeStyle('spec', 'DRAFT')}>{c.anchorKind ?? ''} {c.anchorId}</span>}
        {c.resolvedAt && <span style={badgeStyle('run', 'PASSED')}>resolved</span>}
        <span style={{ ...mutedText, marginLeft: 'auto' }}>{new Date(c.createdAt).toLocaleString()}</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--color-on-surface)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{renderBody(c.body)}</div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        {onReply && <Action onClick={onReply}>Reply</Action>}
        {onResolve && <Action onClick={onResolve}>{c.resolvedAt ? 'Reopen' : 'Resolve'}</Action>}
        {onDelete && <Action onClick={onDelete}>Delete</Action>}
      </div>
    </div>
  )
}

function renderBody(body: string): ReactNode {
  // Highlight @mentions inline.
  const parts = body.split(/(@[a-zA-Z0-9._-]{2,60})/g)
  return parts.map((p, i) => (/^@[a-zA-Z0-9._-]{2,60}$/.test(p) ? <span key={i} style={{ color: 'var(--color-primary)', fontWeight: 700 }}>{p}</span> : <span key={i}>{p}</span>))
}
function Action({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button onClick={onClick} style={{ border: 'none', background: 'none', color: 'var(--color-outline)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: 0 }}>{children}</button>
}
function initials(id: string): string {
  const s = (id || '?').replace(/[^a-zA-Z0-9]/g, '')
  return (s.slice(0, 2) || '?').toUpperCase()
}
