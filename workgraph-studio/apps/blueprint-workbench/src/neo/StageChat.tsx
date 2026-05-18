/**
 * M41.2 — Stage Chat.
 *
 * A Slack-like docked panel at the bottom of the Workbench Neo cockpit.
 * Per-stage thread of operator-to-agent guidance that:
 *   • persists across stage navigation (one thread per stageKey)
 *   • feeds into the NEXT stage run via prompt-composer's loopDefaultTask
 *     template ({{#operatorChat}} block) — implemented in
 *     workgraph-api/src/modules/blueprint/blueprint.router.ts:buildLoopStageVars
 *   • does NOT pause / interrupt a running attempt (that's M41.2.1)
 *
 * Polling cadence is gentle (5s). When the operator sends, we optimistically
 * append to the local list and refresh.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type LoopStage, type StageChatMessage } from '../api'

interface StageChatProps {
  sessionId: string
  stage: LoopStage | undefined
  /** seed thread from session.metadata.stageChats — avoids a flash on first render */
  seedThread?: StageChatMessage[]
}

const POLL_MS = 5000
const MAX_MESSAGE_LEN = 4000

export function StageChat({ sessionId, stage, seedThread }: StageChatProps) {
  const stageKey = stage?.key
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const query = useQuery({
    queryKey: ['stageMessages', sessionId, stageKey],
    queryFn: () => api.listStageMessages(sessionId, stageKey!),
    enabled: Boolean(stageKey),
    refetchInterval: POLL_MS,
    initialData: seedThread ? { items: seedThread } : undefined,
  })

  const messages = query.data?.items ?? []

  const post = useMutation({
    mutationFn: (content: string) => api.postStageMessage(sessionId, stageKey!, { content }),
    onSuccess: (result) => {
      qc.setQueryData(['stageMessages', sessionId, stageKey], { items: result.thread })
      setDraft('')
    },
  })

  // Auto-scroll to bottom whenever messages change.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, stageKey])

  // Reset the draft when switching stages so guidance for stage A doesn't
  // accidentally land on stage B.
  useEffect(() => { setDraft('') }, [stageKey])

  const grouped = useMemo(() => groupByDay(messages), [messages])

  if (!stage) {
    return (
      <section className="neo-stage-chat empty" aria-label="Stage chat">
        <p>Pick a stage on the left to drop guidance for the agent.</p>
      </section>
    )
  }

  const canSend = draft.trim().length > 0 && draft.length <= MAX_MESSAGE_LEN && !post.isPending

  return (
    <section className="neo-stage-chat" aria-label={`Stage chat: ${stage.label}`}>
      <header className="chat-head">
        <div>
          <strong>Stage chat</strong>
          <span>{stage.label} · {stage.agentRole}</span>
        </div>
        <span className="chat-thread-count">{messages.length} message{messages.length === 1 ? '' : 's'}</span>
      </header>

      <div className="chat-stream" ref={scrollRef} role="log" aria-live="polite">
        {messages.length === 0 && (
          <p className="chat-empty">
            No guidance yet. Drop a hint like <em>"use Optional&lt;&gt; not nullable refs"</em>{' '}
            and the agent will see it on its next attempt of <strong>{stage.label}</strong>.
          </p>
        )}
        {grouped.map(group => (
          <div key={group.day} className="chat-day-group">
            <div className="chat-day-divider"><span>{group.day}</span></div>
            {group.items.map(m => (
              <article key={m.id} className={`chat-msg role-${m.role}`}>
                <header>
                  <strong>{labelForRole(m.role)}</strong>
                  <time>{m.createdAt.slice(11, 16)}</time>
                </header>
                <p>{m.content}</p>
              </article>
            ))}
          </div>
        ))}
      </div>

      <form
        className="chat-compose"
        onSubmit={e => {
          e.preventDefault()
          if (canSend) post.mutate(draft.trim())
        }}
      >
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={`Hint the ${stage.agentRole.toLowerCase()} agent — applied on the next run of "${stage.label}"…`}
          rows={2}
          maxLength={MAX_MESSAGE_LEN}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend) {
              e.preventDefault()
              post.mutate(draft.trim())
            }
          }}
        />
        <div className="chat-compose-actions">
          <span className="chat-hint">
            {post.isError ? (
              <span className="chat-error">{(post.error as Error).message}</span>
            ) : (
              <>⌘/Ctrl + Enter to send · applied on next stage run</>
            )}
          </span>
          <button type="submit" disabled={!canSend}>
            {post.isPending ? 'Sending…' : 'Send hint'}
          </button>
        </div>
      </form>
    </section>
  )
}

function labelForRole(role: StageChatMessage['role']): string {
  switch (role) {
    case 'agent':    return 'Agent'
    case 'system':   return 'System'
    case 'operator': return 'You'
  }
}

function groupByDay(messages: StageChatMessage[]): { day: string; items: StageChatMessage[] }[] {
  const groups = new Map<string, StageChatMessage[]>()
  for (const m of messages) {
    const day = m.createdAt.slice(0, 10) // YYYY-MM-DD
    const bucket = groups.get(day) ?? []
    bucket.push(m)
    groups.set(day, bucket)
  }
  return Array.from(groups.entries()).map(([day, items]) => ({ day: humaniseDay(day), items }))
}

function humaniseDay(yyyyMmDd: string): string {
  const today = new Date().toISOString().slice(0, 10)
  if (yyyyMmDd === today) return 'Today'
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (yyyyMmDd === yesterday) return 'Yesterday'
  return yyyyMmDd
}
