/**
 * M41.1 — Browser notifications + favicon badge for Workbench Neo.
 *
 * Watches a BlueprintSession and fires:
 *   - Browser Notification on:
 *       · stage just transitioned RUNNING → COMPLETED (awaiting verdict)
 *       · a new required, unanswered LLM question appeared
 *       · a stage just FAILED (with the error in the body)
 *   - Soft sound (Web Audio synthesis — no asset needed)
 *   - Favicon badge with count of pending-decision stages
 *
 * Gated behind a one-click "Enable notifications" prompt the first time
 * the user hits the page; the choice persists in localStorage. Falls
 * back gracefully if Notification API is unavailable (older browsers,
 * insecure contexts).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BlueprintSession, LoopStage, StageAttempt } from '../api'

const STORAGE_KEY = 'workbench-neo-notify-permission'
const FAVICON_PRIMARY_COLOR = '#22c55e' // emerald-500
const FAVICON_BG = '#0f172a'             // slate-900

type PermissionState = 'unknown' | 'granted' | 'denied' | 'unsupported'

function loadStored(): PermissionState {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported'
  const v = window.localStorage.getItem(STORAGE_KEY)
  if (v === 'granted' || v === 'denied') return v
  // Browser may already have granted from a prior session
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  return 'unknown'
}

/**
 * Snapshot of the per-stage state we compare against to detect transitions.
 * Keyed by stage.key.
 */
interface StageSnapshot {
  status?: StageAttempt['status']
  verdict?: StageAttempt['verdict']
  unansweredQuestionIds: string[]
}

function snapshotOf(stage: LoopStage, attempts: StageAttempt[], answeredIds: Set<string>): StageSnapshot {
  const latest = attempts.at(-1)
  const unansweredQuestionIds = (stage.questions ?? [])
    .filter(q => q.required && !answeredIds.has(q.id))
    .map(q => q.id)
  return { status: latest?.status, verdict: latest?.verdict, unansweredQuestionIds }
}

/** Synth chime via Web Audio (no asset files). */
function playChime(kind: 'attention' | 'success' | 'error') {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return
  try {
    const ctx = new window.AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    const freq = kind === 'attention' ? 660 : kind === 'success' ? 880 : 220
    osc.frequency.value = freq
    osc.type = 'sine'
    gain.gain.setValueAtTime(0, ctx.currentTime)
    gain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
    osc.start()
    osc.stop(ctx.currentTime + 0.4)
    setTimeout(() => ctx.close(), 600)
  } catch {
    // ignore — autoplay restrictions etc.
  }
}

/** Repaint the tab favicon with a small badge count drawn via canvas. */
function paintFavicon(count: number) {
  if (typeof document === 'undefined') return
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  // Base
  ctx.fillStyle = FAVICON_BG
  ctx.beginPath()
  ctx.roundRect?.(0, 0, size, size, 6)
  if (!ctx.roundRect) ctx.fillRect(0, 0, size, size)
  ctx.fill()
  // Letter "N"
  ctx.fillStyle = '#e2e8f0'
  ctx.font = 'bold 18px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('N', size / 2, size / 2 + 1)
  // Badge
  if (count > 0) {
    const r = 8
    ctx.fillStyle = FAVICON_PRIMARY_COLOR
    ctx.beginPath()
    ctx.arc(size - r, r, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#0f172a'
    ctx.font = 'bold 11px system-ui, sans-serif'
    ctx.fillText(count > 9 ? '9+' : String(count), size - r, r + 1)
  }
  const url = canvas.toDataURL('image/png')
  let link = document.querySelector("link[rel*='icon']") as HTMLLinkElement | null
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.href = url
}

export function NeoNotifier({ session }: { session: BlueprintSession | null }) {
  const [permission, setPermission] = useState<PermissionState>(() => loadStored())
  const previousSnapshots = useRef<Map<string, StageSnapshot>>(new Map())
  const firstPaint = useRef(true)

  // Watch the session and emit notifications on relevant transitions.
  useEffect(() => {
    if (!session) {
      previousSnapshots.current.clear()
      firstPaint.current = true
      paintFavicon(0)
      return
    }
    const stages = session.loopDefinition?.stages ?? []
    const answeredIds = new Set((session.decisionAnswers ?? []).map(a => a.questionId))
    const next = new Map<string, StageSnapshot>()
    let attentionCount = 0
    const events: Array<{ stage: LoopStage; kind: 'verdict_due' | 'question' | 'failed' }> = []

    for (const stage of stages) {
      const attempts = (session.stageAttempts ?? []).filter(a => a.stageKey === stage.key)
      const snap = snapshotOf(stage, attempts, answeredIds)
      next.set(stage.key, snap)
      const prev = previousSnapshots.current.get(stage.key)

      // Count attention items for favicon badge
      const latest = attempts.at(-1)
      const awaiting = latest?.status === 'COMPLETED' && !latest.verdict
      if (awaiting) attentionCount += 1
      if (snap.unansweredQuestionIds.length > 0) attentionCount += 1

      // First-paint: don't fire notifications, just initialize snapshots
      if (firstPaint.current) continue

      // Transition: RUNNING → COMPLETED (no verdict yet) → awaiting verdict
      if (prev?.status === 'RUNNING' && snap.status === 'COMPLETED' && !snap.verdict) {
        events.push({ stage, kind: 'verdict_due' })
      }
      // Transition: any → FAILED
      if (prev?.status !== 'FAILED' && snap.status === 'FAILED') {
        events.push({ stage, kind: 'failed' })
      }
      // New required, unanswered question appeared
      const newQuestionIds = snap.unansweredQuestionIds.filter(id => !(prev?.unansweredQuestionIds ?? []).includes(id))
      if (newQuestionIds.length > 0) {
        events.push({ stage, kind: 'question' })
      }
    }

    previousSnapshots.current = next
    firstPaint.current = false
    paintFavicon(attentionCount)

    // Fire notifications + chime
    if (events.length > 0 && permission === 'granted' && typeof Notification !== 'undefined') {
      for (const ev of events) {
        const title = ev.kind === 'verdict_due'
          ? `${ev.stage.label} awaits your verdict`
          : ev.kind === 'failed'
            ? `${ev.stage.label} failed`
            : `${ev.stage.label} — new question for you`
        const body = ev.kind === 'failed'
          ? ((session.stageAttempts ?? []).filter(a => a.stageKey === ev.stage.key).at(-1)?.error ?? 'See the stage details.')
          : ev.kind === 'verdict_due'
            ? 'Open Workbench Neo to approve or send back.'
            : 'The agent needs a clarification before continuing.'
        try {
          const n = new Notification(title, { body, tag: `${session.id}:${ev.stage.key}:${ev.kind}` })
          n.onclick = () => { window.focus(); n.close() }
        } catch {
          // ignored
        }
      }
      playChime(events.some(e => e.kind === 'failed') ? 'error' : 'attention')
    }
  }, [session?.id, session?.stageAttempts, session?.decisionAnswers, permission])

  const stageNames = useMemo(() => session?.loopDefinition?.stages.map(s => s.label).join(' › ') ?? '', [session?.loopDefinition])

  if (permission === 'unsupported') return null
  if (permission === 'granted' || permission === 'denied') return null

  // First-visit CTA: minimal, dismissable, persists choice
  return (
    <div className="neo-notify-prompt" role="status">
      <div>
        <strong>Stay in flow.</strong>{' '}
        Enable browser notifications so Workbench Neo can tell you when{' '}
        <em>{stageNames || 'a stage'}</em> needs your attention.
      </div>
      <div className="neo-notify-actions">
        <button
          type="button"
          className="neo-notify-allow"
          onClick={async () => {
            try {
              const result = await Notification.requestPermission()
              const next: PermissionState = result === 'granted' ? 'granted' : 'denied'
              window.localStorage.setItem(STORAGE_KEY, next)
              setPermission(next)
              if (next === 'granted') playChime('success')
            } catch {
              setPermission('denied')
              window.localStorage.setItem(STORAGE_KEY, 'denied')
            }
          }}
        >
          Allow
        </button>
        <button
          type="button"
          className="neo-notify-skip"
          onClick={() => {
            window.localStorage.setItem(STORAGE_KEY, 'denied')
            setPermission('denied')
          }}
        >
          Not now
        </button>
      </div>
    </div>
  )
}
