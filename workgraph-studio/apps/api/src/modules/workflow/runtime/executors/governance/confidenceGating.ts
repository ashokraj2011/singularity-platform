/**
 * Confidence-gated autonomy — pure, FAIL-CLOSED decision for whether a governance
 * gate's MANUAL approval can be auto-approved based on confidence + risk.
 *
 * SAFETY CONTRACT (enforced by the CALLER, not here): invoke this ONLY when the gate
 * status is 'APPROVAL_REQUESTED' AND blocked.length === 0. This function never sees a
 * real governance block and can only ever say "auto-approve this MANUAL review" — it
 * cannot convert a BLOCKED into PASSED. Anything unknown / missing / below-threshold
 * returns NO auto-approve. Default inert: disabled unless a gate opts in.
 *
 * See docs/confidence-gated-autonomy.md.
 */

export type ConfidenceGatingConfig = {
  enabled?: boolean
  minConfidence?: number          // 0..1
  maxCriticality?: string         // LOW | MEDIUM | HIGH | CRITICAL
  confidenceSource?: 'verify' | 'context' | 'both'
  shadow?: boolean                // compute the verdict but never actually approve
}

export type ConfidenceVerdict = {
  autoApprove: boolean
  shadowWouldApprove: boolean
  reason: string
  evidence: Record<string, unknown>
}

const CRITICALITY_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

function isRec(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

/** Global kill-switch — forces every gate back to human review regardless of config. */
function killSwitchOn(): boolean {
  return String(process.env.GOVERNANCE_CONFIDENCE_GATING_DISABLED ?? '').toLowerCase() === 'true'
}

function deny(reason: string, evidence: Record<string, unknown>): ConfidenceVerdict {
  return { autoApprove: false, shadowWouldApprove: false, reason, evidence }
}

export function evaluateConfidenceGating(input: {
  config: ConfidenceGatingConfig | undefined
  context: Record<string, unknown>
}): ConfidenceVerdict {
  const cfg = input.config ?? {}
  const ctx = input.context ?? {}

  const confidence = typeof ctx._confidence === 'number' ? ctx._confidence : null
  const verificationPassed = ctx._verificationPassed === true
    || (isRec(ctx._verification) && String(ctx._verification.status ?? '').toUpperCase() === 'PASS')
  const criticality = typeof ctx._criticality === 'string' ? ctx._criticality.toUpperCase() : null
  const minConfidence = typeof cfg.minConfidence === 'number' ? cfg.minConfidence : 0.9
  const source = cfg.confidenceSource ?? 'verify'
  const evidence: Record<string, unknown> = {
    confidence, verificationPassed, criticality, minConfidence, source,
    maxCriticality: cfg.maxCriticality ?? null,
  }

  // ── Fail-closed gates (a real failure is NOT a shadow "would-approve") ──────
  if (killSwitchOn()) return deny('kill-switch (GOVERNANCE_CONFIDENCE_GATING_DISABLED=true)', evidence)
  if (cfg.enabled !== true) return deny('confidence-gating not enabled on this gate', evidence)

  if (cfg.maxCriticality) {
    const maxIdx = CRITICALITY_ORDER.indexOf(cfg.maxCriticality.toUpperCase())
    // Unknown criticality is treated as too risky (fail-closed) whenever a ceiling is set.
    const critIdx = criticality ? CRITICALITY_ORDER.indexOf(criticality) : Number.POSITIVE_INFINITY
    if (critIdx === Number.POSITIVE_INFINITY) return deny('criticality unknown; a maxCriticality ceiling is set', evidence)
    if (maxIdx >= 0 && critIdx > maxIdx) return deny(`criticality ${criticality} exceeds max ${cfg.maxCriticality.toUpperCase()}`, evidence)
  }

  const needVerify = source === 'verify' || source === 'both'
  const needContext = source === 'context' || source === 'both'
  if (needVerify && !verificationPassed) return deny('verification did not pass (or is absent)', evidence)
  if (needContext && (confidence == null || confidence < minConfidence)) {
    return deny(`confidence ${confidence ?? 'absent'} < ${minConfidence}`, evidence)
  }

  // ── All real gates passed. Shadow => log-only, never approve. ───────────────
  if (cfg.shadow === true) {
    return { autoApprove: false, shadowWouldApprove: true, reason: 'shadow: would auto-approve', evidence }
  }
  return {
    autoApprove: true,
    shadowWouldApprove: false,
    reason: `auto-approved (source=${source}, confidence=${confidence ?? 'verify-pass'} ≥ ${minConfidence}, criticality=${criticality ?? 'n/a'} ≤ ${cfg.maxCriticality ?? 'n/a'})`,
    evidence,
  }
}
