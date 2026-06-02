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
 *   ⏸ = paused for MCP approval
 *   ⏪ = sent back
 *
 * M41.4 — Renders the NeoThemePicker swatch row at the bottom so the
 * theme control is always reachable without taking center-pane real
 * estate. Optional — pass null/undefined as theme/onTheme to suppress.
 */
import { useMemo, type ReactNode } from 'react'
import type { BlueprintSession, LlmModelCatalogEntry, StageAttempt } from '../api'
import { stageMode, stageModeMeta } from './stageMode'

type StageStatus = 'pending' | 'running' | 'paused' | 'awaiting' | 'pass' | 'risk_accepted' | 'failed' | 'sent_back'

function deriveStatus(latest: StageAttempt | undefined): StageStatus {
  if (!latest) return 'pending'
  if (latest.status === 'RUNNING') return 'running'
  if (latest.status === 'PAUSED') return 'paused'
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
    case 'paused': return '⏸'
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
  modelCatalog,
  stageModelAliases,
  defaultModelAlias,
  onStageModelChange,
  footer,
}: {
  session: BlueprintSession
  activeStageKey: string | null
  onStage: (stageKey: string) => void
  /** M42.7 — per-stage model picker support. When all four model* props are
   *  provided, each rail row renders a compact <select> that pins a model
   *  alias for that stage. Omit them to fall back to the legacy rail. */
  modelCatalog?: LlmModelCatalogEntry[]
  stageModelAliases?: Record<string, string>
  defaultModelAlias?: string
  onStageModelChange?: (stageKey: string, alias: string | null) => void
  /** Optional footer slot — used by WorkbenchNeo to dock the
   *  NeoThemePicker so it's always reachable from the rail. */
  footer?: ReactNode
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

  const modelPickerEnabled = Boolean(modelCatalog && modelCatalog.length > 0 && onStageModelChange)

  return (
    <aside className="neo-loop-rail" aria-label="Loop stages">
      <header>
        <span className="rail-title">Loop</span>
        <span className="rail-subtitle">{session.loopDefinition?.name ?? 'Capability run'}</span>
      </header>
      <ol>
        {items.map(({ stage, status, attemptCount }, index) => {
          const isActive = activeStageKey === stage.key
          const needsAttention = status === 'awaiting' || status === 'paused' || (status === 'pending' && session.currentStageKey === stage.key)
          const pinned = stageModelAliases?.[stage.key] ?? ''
          // Pin precedence: per-stage > session default > catalog default
          const effective = pinned || defaultModelAlias || ''
          return (
            <li key={stage.key} className={`rail-row ${status} ${isActive ? 'active' : ''} ${needsAttention ? 'attention' : ''}`}>
              <button type="button" onClick={() => onStage(stage.key)}>
                <span className="rail-pip" aria-hidden>{statusGlyph(status)}</span>
                <span className="rail-label">
                  <strong>{stage.label}</strong>
                  <small>{stage.agentRole}{attemptCount > 0 ? ` · attempt ${attemptCount}` : ''}{stage.approvalRequired ? ' · approval' : ''}</small>
                </span>
                <span className={`rail-mode-chip ${stageModeMeta(stageMode(stage)).chipClass}`}>{stageModeMeta(stageMode(stage)).label}</span>
                {needsAttention && <span className="rail-attention-dot" aria-label="needs attention" />}
              </button>
              {modelPickerEnabled && (
                <label className="rail-model-picker" title="Model used by this stage">
                  <select
                    value={pinned}
                    onChange={e => onStageModelChange?.(stage.key, e.target.value || null)}
                    onClick={e => e.stopPropagation()}
                    aria-label={`Model for ${stage.label}`}
                  >
                    <option value="">{`(default${defaultModelAlias ? `: ${defaultModelAlias}` : ''})`}</option>
                    {modelCatalog!.map(m => (
                      <option key={m.id} value={m.id} disabled={m.ready === false}>
                        {m.label ?? m.id}
                        {m.costTier ? ` · ${m.costTier}` : ''}
                        {m.id === effective && !pinned ? ' (in use)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {index < items.length - 1 && <span className="rail-connector" aria-hidden />}
            </li>
          )
        })}
      </ol>
      {footer}
    </aside>
  )
}

export type { StageStatus }
export { deriveStatus, statusGlyph }
