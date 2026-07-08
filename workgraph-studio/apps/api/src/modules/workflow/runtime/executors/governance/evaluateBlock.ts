/**
 * TS port of context-fabric's `_evaluate_governance_block`
 * (`context-fabric/.../governed/stage_driver.py`). Kept in PARITY with
 * `context-fabric/.../tests/test_governance_gate.py` so a GOVERNANCE_GATE node
 * decides identically to CF's in-stage enforcement gate.
 *
 * Returns the unsatisfied REQUIRED/BLOCKING governance controls (empty ⇒ may
 * proceed). Fail-closed: a REQUIRED/BLOCKING required-evidence entry or a
 * blockingControl blocks unless its key is satisfied or waived. ADVISORY
 * contributes nothing — the gate is a no-op for advisory overlays.
 */

export interface GovernanceOverlay {
  /** Default mode applied to requiredEvidence entries that omit their own. */
  effectiveMode?: string
  requiredEvidence?: Array<{ evidenceKey?: string; mode?: string; stageKey?: string; reason?: string }>
  blockingControls?: Array<{ controlKey?: string; reason?: string; sourceCapabilityId?: string }>
  /** Stable hash of the resolved overlay; used to snapshot what applied. */
  overlayHash?: string
  [k: string]: unknown
}

export interface GovernanceBlock {
  controlKey: string
  kind: 'evidence' | 'control'
  mode: string
  reason: string
  stageKey?: string
  sourceCapabilityId?: string
  waivable: boolean
}

export function evaluateGovernanceBlock(
  overlay: GovernanceOverlay | null | undefined,
  satisfied: ReadonlySet<string>,
  waived: ReadonlySet<string>,
): GovernanceBlock[] {
  if (!overlay || typeof overlay !== 'object') return []
  const blocked: GovernanceBlock[] = []
  const defaultMode = String(overlay.effectiveMode ?? 'ADVISORY').toUpperCase()

  for (const ev of overlay.requiredEvidence ?? []) {
    if (!ev || typeof ev !== 'object') continue
    const mode = String(ev.mode ?? defaultMode).toUpperCase()
    if (mode !== 'REQUIRED' && mode !== 'BLOCKING') continue
    const key = ev.evidenceKey
    if (typeof key === 'string' && key && !satisfied.has(key) && !waived.has(key)) {
      blocked.push({
        controlKey: key,
        kind: 'evidence',
        mode,
        reason: ev.reason ?? `required evidence '${key}' not satisfied`,
        stageKey: ev.stageKey,
        waivable: true,
      })
    }
  }

  for (const c of overlay.blockingControls ?? []) {
    if (!c || typeof c !== 'object') continue
    const key = c.controlKey
    if (typeof key === 'string' && key && !satisfied.has(key) && !waived.has(key)) {
      blocked.push({
        controlKey: key,
        kind: 'control',
        mode: 'BLOCKING',
        reason: c.reason ?? `blocking control '${key}' not satisfied`,
        sourceCapabilityId: c.sourceCapabilityId,
        waivable: true,
      })
    }
  }

  return blocked
}

export type GateOutcome = 'PASSED' | 'WARNED' | 'BLOCKED' | 'APPROVAL_REQUESTED'

/**
 * Pure decision: given the unsatisfied blocking controls and the node's mode,
 * what should the gate do? AUTOMATIC opens an approval/waiver route only when
 * every blocking control is waivable; otherwise it falls back to BLOCKED.
 */
export function decideGateStatus(blocked: GovernanceBlock[], mode: string): GateOutcome {
  if (blocked.length === 0) return 'PASSED'
  if (mode === 'SOFT_WARN') return 'WARNED'
  if (mode === 'AUTOMATIC' && blocked.every(b => b.waivable)) return 'APPROVAL_REQUESTED'
  return 'BLOCKED'
}
