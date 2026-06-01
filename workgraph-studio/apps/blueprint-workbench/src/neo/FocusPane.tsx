/**
 * M41.1 — Focus Pane.
 *
 * The center column of the new cockpit. At any moment exactly ONE thing
 * demands the operator's attention — surface it as a focused hero with a
 * single primary CTA, all relevant context, and lightweight secondary
 * actions. No tabs. No sidebar scrolling.
 *
 * The parent (WorkbenchNeo) decides the "intent" — which CTA to
 * promote — based on stage state. FocusPane just renders it.
 *
 * Intents:
 *   - 'idle'       — no stage selected
 *   - 'run'        — stage is fresh, needs operator to kick it off
 *   - 'running'    — agent is working; cockpit on the right has activity
 *   - 'mcp-approval' — MCP paused on a tool/governance approval
 *   - 'answer'     — agent is blocked on a required question
 *   - 'approve'    — agent finished, awaiting verdict
 *   - 'rework'     — last attempt failed / sent back; needs re-run or rework
 *   - 'completed'  — stage closed, here for reference
 *
 * Footer actions are constant: send-back is always reachable but
 * deliberately demoted to a secondary slot so the operator picks it
 * intentionally, not by mistake.
 */
import type { ReactNode } from 'react'
import type { LoopStage, StageAttempt } from '../api'

export type FocusIntent =
  | 'idle'
  | 'run'
  | 'running'
  | 'mcp-approval'
  | 'answer'
  | 'approve'
  | 'rework'
  | 'completed'

export interface FocusAction {
  label: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean
}

export interface FocusPaneProps {
  stage: LoopStage | undefined
  latest: StageAttempt | undefined
  intent: FocusIntent
  /** Stage hero info (renderable badge area below the title). */
  badges?: ReactNode
  /** Body slot — typically the question card(s) or response preview. */
  body?: ReactNode
  /** Primary CTA — promoted, hero-size button. */
  primaryAction?: FocusAction
  /** Secondary actions — listed below the primary as small buttons. */
  secondaryActions?: FocusAction[]
  /** Send-back trigger — always reachable, but demoted to a footer button. */
  onOpenSendBack?: () => void
  /** Inline error/warning to surface above the CTA. */
  inlineError?: string | null
  /** Optional helper text under the CTA (e.g. "all required questions answered"). */
  helperText?: string
}

export function FocusPane({
  stage,
  latest,
  intent,
  badges,
  body,
  primaryAction,
  secondaryActions,
  onOpenSendBack,
  inlineError,
  helperText,
}: FocusPaneProps) {
  if (!stage) {
    return (
      <section className="neo-focus neo-focus-empty">
        <div className="focus-empty-art" aria-hidden>◌</div>
        <h2>Pick a stage on the left</h2>
        <p>Workbench Neo always focuses on one stage at a time.</p>
      </section>
    )
  }

  const intentBanner = intentBannerCopy(intent, stage, latest)

  return (
    <section className={`neo-focus intent-${intent}`} aria-labelledby="neo-focus-title">
      <header className="focus-head">
        <span className="focus-stage-key">{stage.key}</span>
        <h2 id="neo-focus-title">{stage.label}</h2>
        {stage.description && <p className="focus-stage-desc">{stage.description}</p>}
        {badges && <div className="focus-badges">{badges}</div>}
      </header>

      {intentBanner && <div className={`focus-banner banner-${intent}`}>{intentBanner}</div>}

      {body && <div className="focus-body">{body}</div>}

      {inlineError && (
        <p className="focus-error" role="alert">{inlineError}</p>
      )}

      {/* (2026-05-31) Render the action footer whenever there's a primary
          action OR any secondary actions. Previously gated on primaryAction
          alone, which hid the entire footer — including the "Reset & rerun" /
          "Cancel attempt" recovery actions — exactly in the intent==='running'
          state (where primaryAction is undefined), i.e. when a stage is stuck
          and the operator most needs them. */}
      {(primaryAction || (secondaryActions ?? []).length > 0) && (
        <div className="focus-actions">
          {primaryAction && (
            <button
              type="button"
              className="focus-primary"
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled || primaryAction.busy}
            >
              {primaryAction.busy ? <span className="spin" aria-hidden>↻</span> : null}
              <span>{primaryAction.label}</span>
            </button>
          )}
          {helperText && <p className="focus-helper">{helperText}</p>}
          {(secondaryActions ?? []).length > 0 && (
            <div className="focus-secondary-row">
              {(secondaryActions ?? []).map((a, i) => (
                <button
                  key={`${a.label}-${i}`}
                  type="button"
                  className="focus-secondary"
                  onClick={a.onClick}
                  disabled={a.disabled || a.busy}
                >
                  {a.busy ? <span className="spin" aria-hidden>↻</span> : null}
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {onOpenSendBack && (stage.allowedSendBackTo ?? []).length > 0 && (
        <footer className="focus-footer">
          <button type="button" className="focus-footer-link" onClick={onOpenSendBack}>
            ↩ Send stage back…
          </button>
        </footer>
      )}
    </section>
  )
}

function intentBannerCopy(intent: FocusIntent, stage: LoopStage, latest: StageAttempt | undefined): ReactNode {
  switch (intent) {
    case 'answer':
      return <><strong>Agent needs your input.</strong> Required question below — answer it before re-running this stage.</>
    case 'approve':
      return <><strong>Awaiting your verdict.</strong> Review the response and artifacts, then approve or send this stage back.</>
    case 'mcp-approval':
      return <><strong>MCP is waiting for approval.</strong> Review the pending tool call before the agent loop continues.</>
    case 'running':
      return <><strong>Agent is working.</strong> Live activity on the right; this view will update when the stage produces a result.</>
    case 'run':
      return <><strong>Ready to run.</strong> Kick the {stage.agentRole.toLowerCase()} agent off when you're ready.</>
    case 'rework':
      return (
        <>
          <strong>Last attempt didn't pass.</strong> Re-run with new context, or send back to an earlier stage.
          {latest?.error ? <><br /><span style={{ opacity: 0.85 }}>Reason: {latest.error}</span></> : null}
        </>
      )
    case 'completed':
      return <><strong>Stage closed.</strong> This view is read-only — pick another stage on the left to act on.</>
    default:
      return null
  }
}

/**
 * Helper to compute the FocusIntent from session+stage state.
 * Exposed so the parent doesn't duplicate the priority logic.
 *
 * Priority order (highest first):
 *   1. mcp-approval — MCP paused on a tool/governance approval
 *   2. answer  — required, unanswered LLM question exists
 *   3. approve — most recent attempt is COMPLETED without a verdict
 *   4. rework  — most recent attempt is FAILED or verdict NEEDS_REWORK
 *   5. running — most recent attempt is RUNNING
 *   6. completed — stage has PASS/ACCEPTED_WITH_RISK verdict
 *   7. run     — no attempt yet
 *   8. idle    — no stage
 */
export function computeFocusIntent(
  stage: LoopStage | undefined,
  latest: StageAttempt | undefined,
  hasUnansweredRequiredQuestion: boolean,
): FocusIntent {
  if (!stage) return 'idle'
  if (latest?.status === 'PAUSED') return 'mcp-approval'
  if (hasUnansweredRequiredQuestion) return 'answer'
  if (latest?.status === 'COMPLETED' && !latest.verdict) return 'approve'
  if (latest?.status === 'FAILED' || latest?.verdict === 'NEEDS_REWORK' || latest?.verdict === 'BLOCKED') return 'rework'
  if (latest?.status === 'RUNNING') return 'running'
  if (latest?.verdict === 'PASS' || latest?.verdict === 'ACCEPTED_WITH_RISK') return 'completed'
  return 'run'
}
