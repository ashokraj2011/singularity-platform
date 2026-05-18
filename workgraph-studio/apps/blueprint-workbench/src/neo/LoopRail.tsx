/**
 * M41.1 — Vertical Loop Rail.
 *
 * Replaces the horizontal NeoPipeline (App.tsx:1082). Stages render as a
 * compact vertical timeline on the left edge of the screen — saves
 * horizontal space, mirrors the linear loop semantics, and stays out of
 * the way of the FocusPane and LiveCockpit.
 *
 * Status pips:
 *   ●  = current focus
 *   ○  = pending
 *   ✓  = pass / accepted with risk
 *   ✗  = failed
 *   ↻  = running (spins)
 *   ⌛ = awaiting human verdict (animated pulse)
 *   ⏪ = sent back
 */
import { useMemo } from 'react'
import type { BlueprintSession, StageAttempt } from '../api'

type StageStatus = 'pending' | 'running' | 'awaiting' | 'pass' | 'risk_accepted' | 'failed' | 'sent_back'

function deriveStatus(latest: StageAttempt | undefined): StageStatus {
  if (!latest) return 'pending'
  if (latest.status === 'RUNNING') return 'running'
  if (latest.verdict === 'PASS') return 'pass'
  if (latest.verdict === 'ACCEPTED_WITH_RISK') return 'risk_accepted'
  if (latest.verdict === 'NEEDS_REWORK') return 'sent_back'
  if (latest.verdict === 'BLOCKED') return 'failed'
  if (latest.status === 'FAILED') return 'failed'
  if (latest.status === 'COMPLETED' && !latest.verdict) return 'awaiting'
  return 'pending'
}

function statusGlyph(s: StageStatus): string {
  switch (s) {
    case 'running': return '↻'
    case 'awaiting': return '⌛'
    case 'pass': return '✓'
    case 'risk_accepted': return '◑'
    case 'sent_back': return '⏪'
    case 'failed': return '✗'
    default: return '○'
  }
}

export function LoopRail({
  session,
  activeStageKey,
  onStage,
}: {
  session: BlueprintSession
  activeStageKey: string | null
  onStage: (stageKey: string) => void
}) {
  const stages = session.loopDefinition?.stages ?? []
  const items = useMemo(() => stages.map(stage => {
    const attempts = (session.stageAttempts ?? []).filter(a => a.stageKey === stage.key)
    const latest = attempts.at(-1)
    return {
      stage,
      latest,
      status: deriveStatus(latest),
      attemptCount: attempts.length,
    }
  }), [session.stageAttempts, stages])

  return (
    <aside className="neo-loop-rail" aria-label="Loop stages">
      <header>
        <span className="rail-title">Loop</span>
        <span className="rail-subtitle">{session.loopDefinition?.name ?? 'Capability run'}</span>
      </header>
      <ol>
        {items.map(({ stage, status, attemptCount }, index) => {
          const isActive = activeStageKey === stage.key
          const needsAttention = status === 'awaiting' || (status === 'pending' && session.currentStageKey === stage.key)
          return (
            <li key={stage.key} className={`rail-row ${status} ${isActive ? 'active' : ''} ${needsAttention ? 'attention' : ''}`}>
              <button type="button" onClick={() => onStage(stage.key)}>
                <span className="rail-pip" aria-hidden>{statusGlyph(status)}</span>
                <span className="rail-label">
                  <strong>{stage.label}</strong>
                  <small>{stage.agentRole}{attemptCount > 0 ? ` · attempt ${attemptCount}` : ''}</small>
                </span>
                {needsAttention && <span className="rail-attention-dot" aria-label="needs attention" />}
              </button>
              {index < items.length - 1 && <span className="rail-connector" aria-hidden />}
            </li>
          )
        })}
      </ol>
    </aside>
  )
}

export type { StageStatus }
export { deriveStatus, statusGlyph }
