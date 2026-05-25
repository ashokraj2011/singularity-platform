/**
 * M78 Slice 2 — Renders the structured `verification_failure_analysis`
 * payload as an actionable card.
 *
 * Shows two clear sections:
 *   1. INHERITED failures — tests that fail in upstream code the agent
 *      didn't touch. Bug is NOT the agent's fault. Action: create a
 *      remediation work item, or accept the risk to proceed.
 *   2. REGRESSION failures — tests that fail in files the agent DID
 *      edit this attempt. The agent introduced these. Action: send the
 *      stage back so it can fix them.
 *
 * Each failure card shows:
 *   - test FQN
 *   - file path (clickable in future slice)
 *   - exception class + line (when the analyzer could extract them)
 *   - a plain-English hint (when the exception maps to a known pattern,
 *     e.g. NPE → "Often Map.of(null) — Java 9+ rejects null values")
 *
 * Action buttons are wired up here but their handlers come from the
 * parent. Slice 3 will land the "Create remediation WI" endpoint; for
 * now the button stays disabled with a "coming soon" tooltip.
 */
import type { CSSProperties } from 'react'

export interface InheritedFailure {
  test: string
  file: string
  exception?: string
  exceptionLine?: number
  hint?: string
}

export interface VerificationFailureAnalysis {
  // M78 — Two flavours of analysis:
  //   verification_failure_analysis: user must act (Slice 1/2/3)
  //   auto_remediation_spawned:     platform already spawned the WIs (Slice 4)
  kind: 'verification_failure_analysis' | 'auto_remediation_spawned'
  inheritedOnly: boolean
  inheritedFailures: InheritedFailure[]
  regressionFailures: InheritedFailure[]
  unparseable?: Array<{ command: string; reason: string }>
  // M78 Slice 4 — populated when kind === 'auto_remediation_spawned'.
  // One entry per inherited failure that was successfully spawned as
  // a remediation WorkItem. Card surfaces these as a "🤖 spawned" list
  // with deep-links to each WI.
  spawnedWorkItems?: Array<{ id: string; workCode: string; title: string; test: string }>
  spawnErrors?: Array<{ test: string; reason: string }>
  recommendedActions: string[]
}

export interface InheritedFailureCardProps {
  analysis: VerificationFailureAnalysis
  message: string
  /** Slice 3 wires this; pass undefined to keep button disabled. */
  onCreateRemediationWI?: (failure: InheritedFailure) => void
  /** Slice 3+ — accept-with-risk shortcut. */
  onAcceptWithRisk?: () => void
  /** Send back to develop (always available; matches existing UX). */
  onSendBack?: () => void
}

const cardStyle: CSSProperties = {
  background: 'rgba(127, 29, 29, 0.18)',  // muted red
  border: '1px solid rgba(248, 113, 113, 0.45)',
  borderRadius: 8,
  padding: 16,
  marginBottom: 12,
  fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
  fontSize: 13,
  lineHeight: 1.5,
  color: '#fecaca',
}

const inheritedCardStyle: CSSProperties = {
  ...cardStyle,
  background: 'rgba(146, 64, 14, 0.18)',  // muted amber
  border: '1px solid rgba(250, 204, 21, 0.45)',
  color: '#fde68a',
}

const failureRowStyle: CSSProperties = {
  padding: '8px 10px',
  background: 'rgba(0, 0, 0, 0.25)',
  borderRadius: 6,
  marginTop: 8,
  border: '1px solid rgba(255, 255, 255, 0.06)',
}

const headerStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  marginBottom: 8,
  fontFamily: 'system-ui, -apple-system, sans-serif',
}

const actionRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 12,
  flexWrap: 'wrap',
}

const buttonStyle: CSSProperties = {
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid rgba(255, 255, 255, 0.2)',
  background: 'rgba(255, 255, 255, 0.08)',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontWeight: 500,
}

const buttonDisabledStyle: CSSProperties = {
  ...buttonStyle,
  cursor: 'not-allowed',
  opacity: 0.5,
}

function FailureRow({
  failure,
  onCreateRemediationWI,
}: {
  failure: InheritedFailure
  onCreateRemediationWI?: (f: InheritedFailure) => void
}) {
  return (
    <div style={failureRowStyle}>
      <div style={{ fontFamily: 'inherit', fontWeight: 600 }}>{failure.test}</div>
      <div style={{ opacity: 0.85, marginTop: 2 }}>
        {failure.file || '(no file path)'}
        {failure.exceptionLine ? ` : line ${failure.exceptionLine}` : ''}
        {failure.exception ? `  →  ${failure.exception}` : ''}
      </div>
      {failure.hint && (
        <div style={{ opacity: 0.75, marginTop: 4, fontStyle: 'italic' }}>{failure.hint}</div>
      )}
      {onCreateRemediationWI && (
        <button
          type="button"
          style={{ ...buttonStyle, marginTop: 8, fontSize: 11 }}
          onClick={() => onCreateRemediationWI(failure)}
          title="Spawn a separate WorkItem to fix this upstream bug"
        >
          Create remediation WI →
        </button>
      )}
    </div>
  )
}

export function InheritedFailureCard({
  analysis,
  message,
  onCreateRemediationWI,
  onAcceptWithRisk,
  onSendBack,
}: InheritedFailureCardProps) {
  const { inheritedFailures, regressionFailures, recommendedActions, spawnedWorkItems, spawnErrors } = analysis
  const hasInherited = inheritedFailures.length > 0
  const hasRegression = regressionFailures.length > 0
  const isAutoSpawned = analysis.kind === 'auto_remediation_spawned'

  return (
    <div>
      {/* Summary banner — uses the API's message verbatim. */}
      <div style={analysis.inheritedOnly ? inheritedCardStyle : cardStyle}>
        <div style={headerStyle}>
          {isAutoSpawned
            ? '🤖 Auto-remediation spawned — approval re-try pending'
            : analysis.inheritedOnly
              ? '⚠ Approval blocked by upstream bugs (not your agent\'s fault)'
              : '✗ Approval blocked by test failures'}
        </div>
        <div>{message}</div>

        {/* M78 Slice 4 — When the API auto-spawned WIs, show the list
            up top with deep-links. Failures list still renders below
            for context, but without per-row "Create remediation" buttons
            (already done by the platform). */}
        {isAutoSpawned && spawnedWorkItems && spawnedWorkItems.length > 0 && (
          <>
            <div style={{ ...headerStyle, marginTop: 16, color: '#86efac' }}>
              Auto-spawned remediation work items ({spawnedWorkItems.length})
            </div>
            {spawnedWorkItems.map((wi, i) => (
              <div key={`s-${i}`} style={failureRowStyle}>
                <div>
                  <a
                    href={`/work-items/${wi.id}`}
                    style={{ color: '#a7f3d0', fontWeight: 600, textDecoration: 'underline' }}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {wi.workCode}
                  </a>
                  {`  —  ${wi.title}`}
                </div>
                <div style={{ opacity: 0.75, marginTop: 2, fontSize: 12 }}>
                  remediates {wi.test}
                </div>
              </div>
            ))}
          </>
        )}
        {isAutoSpawned && spawnErrors && spawnErrors.length > 0 && (
          <>
            <div style={{ ...headerStyle, marginTop: 12, color: '#fca5a5' }}>
              Auto-spawn errors ({spawnErrors.length}) — manual click required
            </div>
            {spawnErrors.map((err, i) => (
              <div key={`e-${i}`} style={failureRowStyle}>
                <div style={{ fontWeight: 600 }}>{err.test}</div>
                <div style={{ opacity: 0.85, marginTop: 2 }}>{err.reason}</div>
              </div>
            ))}
          </>
        )}

        {hasRegression && (
          <>
            <div style={{ ...headerStyle, marginTop: 16, color: '#fca5a5' }}>
              Regressions — your agent introduced these ({regressionFailures.length})
            </div>
            {regressionFailures.map((f, i) => (
              <FailureRow key={`r-${i}`} failure={f} />
            ))}
          </>
        )}

        {hasInherited && (
          <>
            <div style={{ ...headerStyle, marginTop: 16, color: '#fcd34d' }}>
              Inherited failures — pre-exist in upstream code ({inheritedFailures.length})
            </div>
            {inheritedFailures.map((f, i) => (
              <FailureRow
                key={`i-${i}`}
                failure={f}
                // When auto-spawned, the per-row button is suppressed
                // because the platform already created the WI. The
                // spawnedWorkItems list above is the actionable surface.
                onCreateRemediationWI={isAutoSpawned ? undefined : onCreateRemediationWI}
              />
            ))}
          </>
        )}

        <div style={actionRowStyle}>
          {recommendedActions.includes('send_back_to_develop') && onSendBack && (
            <button type="button" style={buttonStyle} onClick={onSendBack}>
              Send back to Develop
            </button>
          )}
          {recommendedActions.includes('accept_risk') && onAcceptWithRisk && (
            <button type="button" style={buttonStyle} onClick={onAcceptWithRisk}>
              Accept with risk
            </button>
          )}
          {recommendedActions.includes('create_remediation_wi') && (
            <button
              type="button"
              style={onCreateRemediationWI ? buttonStyle : buttonDisabledStyle}
              disabled={!onCreateRemediationWI}
              title={onCreateRemediationWI
                ? 'Spawn a WorkItem per inherited failure'
                : 'Coming in M78 Slice 3 — endpoint pending'}
              onClick={() => {
                // Default behaviour: emit one WI per failure.
                if (!onCreateRemediationWI) return
                for (const f of inheritedFailures) onCreateRemediationWI(f)
              }}
            >
              Create remediation WI{inheritedFailures.length > 1 ? `s (${inheritedFailures.length})` : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Extracts the M78 verification-failure-analysis payload from an unknown
 * error value. Returns null when the error isn't a structured one (e.g.
 * network errors, 401s, legacy validation errors without `details`).
 * Tolerant of both ApiError instances and plain objects (in case React
 * Query strips the prototype across boundaries).
 */
export function getVerificationFailureAnalysis(error: unknown): VerificationFailureAnalysis | null {
  if (!error || typeof error !== 'object') return null
  const e = error as { details?: unknown }
  if (!e.details || typeof e.details !== 'object') return null
  const d = e.details as Record<string, unknown>
  // Accept both Slice 1's manual-action kind and Slice 4's auto-
  // spawned kind. The card branches on `kind` internally.
  if (d.kind !== 'verification_failure_analysis' && d.kind !== 'auto_remediation_spawned') return null
  const kind = d.kind
  // Coerce / validate the shape. Defensive: a server with skew might
  // emit slightly different keys; we don't want to render undefined.
  const inh = Array.isArray(d.inheritedFailures) ? d.inheritedFailures as InheritedFailure[] : []
  const reg = Array.isArray(d.regressionFailures) ? d.regressionFailures as InheritedFailure[] : []
  const rec = Array.isArray(d.recommendedActions)
    ? (d.recommendedActions as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  return {
    kind,
    inheritedOnly: d.inheritedOnly === true,
    inheritedFailures: inh,
    regressionFailures: reg,
    unparseable: Array.isArray(d.unparseable) ? d.unparseable as Array<{ command: string; reason: string }> : undefined,
    spawnedWorkItems: Array.isArray(d.spawnedWorkItems)
      ? d.spawnedWorkItems as Array<{ id: string; workCode: string; title: string; test: string }>
      : undefined,
    spawnErrors: Array.isArray(d.spawnErrors)
      ? d.spawnErrors as Array<{ test: string; reason: string }>
      : undefined,
    recommendedActions: rec,
  }
}
