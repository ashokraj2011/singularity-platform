/**
 * M71 Slice G — PhaseStrip.
 *
 * Renders the 7 governed-loop phases (PLAN → EXPLORE → ACT → VERIFY →
 * REPAIR → SELF_REVIEW → FINALIZE) as a horizontal pill row, highlighting
 * the current phase and dimming the rest. Drops into any stage view that
 * carries phase state (BlueprintSession.metadata.phaseStateByStage from
 * Slice F's adapter, once workgraph-api persists it).
 *
 * Rendering rules:
 *   - "Current" phase = solid color, bold label, slight elevation.
 *   - Phases the loop has already passed through (in `history`) = filled
 *     gray to show "done".
 *   - Future phases = outline only, dim.
 *   - REPAIR shows the retry count when current_phase === REPAIR.
 *   - When approvalPending=true, the SELF_REVIEW pill gets an amber halo
 *     so operators see "human gate is open" without scrolling to the
 *     approval card.
 *
 * Read-only. No interactions — clicking does nothing today. Future:
 * click → jump to that phase's receipt in the evidence pane.
 */
import type { ReactElement } from 'react'
import { useMemo } from 'react'

// Mirror context-fabric's PHASE_ORDER so changes there stay in sync via
// type-narrowing in tests. (No shared types between Python + TS in this repo
// yet; literal-typing it is the lightest viable contract.)
export const PHASE_ORDER = [
  'PLAN',
  'EXPLORE',
  'ACT',
  'VERIFY',
  'REPAIR',
  'SELF_REVIEW',
  'FINALIZE',
] as const
export type GovernedPhase = (typeof PHASE_ORDER)[number]

export interface PhaseStripState {
  currentPhase: string
  // Optional history list — entries from PhaseState.history; we just care
  // about which phases have been visited at least once.
  history?: Array<{ from?: string; to?: string }>
  repairAttempts?: number
  approvalPending?: boolean
}

interface PhaseStripProps {
  state: PhaseStripState | null | undefined
  /** Optional override for the pill set — defaults to PHASE_ORDER. */
  phases?: readonly string[]
}

// Short labels for the pill row. The long names are accessible via title=.
const PHASE_SHORT_LABEL: Record<string, string> = {
  PLAN:         'Plan',
  EXPLORE:      'Explore',
  ACT:          'Act',
  VERIFY:       'Verify',
  REPAIR:       'Repair',
  SELF_REVIEW:  'Review',
  FINALIZE:     'Finalize',
}

export function PhaseStrip({ state, phases }: PhaseStripProps): ReactElement | null {
  const phaseList = phases ?? PHASE_ORDER

  const visited = useMemo(() => {
    if (!state?.history) return new Set<string>()
    const seen = new Set<string>()
    for (const entry of state.history) {
      if (entry.from) seen.add(entry.from)
      if (entry.to) seen.add(entry.to)
    }
    if (state.currentPhase) seen.add(state.currentPhase)
    return seen
  }, [state?.history, state?.currentPhase])

  if (!state) return null

  const currentIdx = phaseList.indexOf(state.currentPhase)

  return (
    <div
      role="group"
      aria-label="Governed-loop phase"
      style={{
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        padding: '6px 10px',
        background: '#0f172a',
        borderRadius: 10,
        overflowX: 'auto',
        fontFamily: 'inherit',
        fontSize: 11,
      }}
    >
      {phaseList.map((phase, idx) => {
        const isCurrent = phase === state.currentPhase
        const isPast = idx < currentIdx || visited.has(phase)
        const isApprovalHalo = isCurrent && phase === 'SELF_REVIEW' && state.approvalPending
        const showRetry = isCurrent && phase === 'REPAIR' && (state.repairAttempts ?? 0) > 0

        const baseStyle: React.CSSProperties = {
          padding: '3px 9px',
          borderRadius: 999,
          fontWeight: 600,
          letterSpacing: '0.06em',
          fontVariant: 'small-caps',
          whiteSpace: 'nowrap',
          transition: 'all 0.18s',
        }

        let style: React.CSSProperties
        if (isCurrent) {
          // Solid current-phase pill; amber halo when approval is pending.
          style = {
            ...baseStyle,
            background: isApprovalHalo ? '#f59e0b' : '#3b82f6',
            color: '#fff',
            boxShadow: isApprovalHalo
              ? '0 0 0 2px rgba(245,158,11,0.35)'
              : '0 0 0 1px rgba(59,130,246,0.4)',
          }
        } else if (isPast) {
          style = {
            ...baseStyle,
            background: '#334155',
            color: '#cbd5e1',
          }
        } else {
          style = {
            ...baseStyle,
            background: 'transparent',
            color: '#64748b',
            border: '1px solid #334155',
          }
        }

        return (
          <span
            key={phase}
            style={style}
            title={
              `${phase}` +
              (isCurrent ? ' (current)' : isPast ? ' (visited)' : ' (not yet)') +
              (showRetry ? ` — retry ${state.repairAttempts}` : '') +
              (isApprovalHalo ? ' — approval pending' : '')
            }
          >
            {PHASE_SHORT_LABEL[phase] ?? phase}
            {showRetry ? ` ×${state.repairAttempts}` : ''}
          </span>
        )
      })}
    </div>
  )
}
