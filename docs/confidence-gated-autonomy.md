# Confidence-gated autonomy (risk-based governance routing) — design

Status: **design only** (no code). Deliberately not built blind — a wrong change to the
governance gate could *bypass governance*, so this spec pins the safety invariant first
and makes a bypass impossible by construction.

## Problem

Governance today is binary. A `GOVERNANCE_GATE` in `MANUAL_REVIEW` mode always pauses for
a human, no matter how low-risk or high-confidence the change is
(`GovernanceGateExecutor.ts:634` — `mode === 'MANUAL_REVIEW' ? 'APPROVAL_REQUESTED' : …`).
Best-in-class agentic SDLC routes by **risk**: auto-proceed high-confidence + low-risk
changes, escalate the rest — so humans spend attention where it matters. This turns
role-based gates into **risk-based** gates.

## The safety invariant (the entire point)

> Confidence-gating may ONLY convert an `APPROVAL_REQUESTED` into a `PASSED`, and ONLY when
> there are **zero unsatisfied blocking controls** (`blocked.length === 0`). It can NEVER
> convert a `BLOCKED` into `PASSED`. A real governance block always wins.

Why this is safe by construction: `decideGateStatus(blocked, mode)` (`governance/evaluateBlock.ts:84`)
returns `BLOCKED` whenever an unsatisfied REQUIRED/BLOCKING control exists (for non-MANUAL
modes). `MANUAL_REVIEW` forces `APPROVAL_REQUESTED` even when `blocked` is non-empty — so the
gate MUST additionally check `blocked.length === 0` before auto-approving. The auto-approve
hook therefore sits **between** the status decision and the pause, and is guarded by
`status === 'APPROVAL_REQUESTED' && blocked.length === 0`:

```ts
// GovernanceGateExecutor.ts — immediately AFTER line 634 (status computed), BEFORE the
// `blockNode` branch at 668. The guard is in the CALLER, so the resolver below can never
// widen it.
let status = (mode === 'MANUAL_REVIEW' ? 'APPROVAL_REQUESTED' : decideGateStatus(blocked, mode)) as GateStatus
if (status === 'APPROVAL_REQUESTED' && blocked.length === 0) {
  const verdict = evaluateConfidenceGating(node, instance, { checks, satisfied, waived })
  if (verdict.autoApprove) {
    status = 'PASSED'
    output.governanceGate.note = `auto-approved: ${verdict.reason}`
    await recordAutoApproval(instance, node, output, verdict)   // full-weight receipt + event
  } else if (verdict.shadowWouldApprove) {
    await logEvent('GovernanceGateWouldAutoApprove', 'WorkflowNode', node.id, actorId, verdict.evidence)
    // still falls through to APPROVAL_REQUESTED — shadow mode never actually approves
  }
}
```

## Signals

- **Confidence** — how sure we are the work is correct:
  - the Part-B verify verdict on the run's consumables (`_verification.status === 'PASS'` + coverage),
    surfaced by the WF-3 decision record;
  - and/or a context field `_confidence` (0–1) set by an upstream `VERIFIER` / agent stage.
- **Risk** — blast radius of proceeding without a human:
  - capability `criticality`, the severity of the *satisfied-but-manual* controls, and change
    size (e.g. files changed, from the decision record).

## Decision — `evaluateConfidenceGating` (new `governance/confidenceGating.ts`)

`autoApprove = enabled && confidence ≥ minConfidence && criticality ≤ maxCriticality &&
verificationNotFailed && blocked.length === 0`. **Fail-closed**: missing/unknown confidence,
a failed/absent verify verdict, or criticality above the ceiling ⇒ NOT auto-approved (escalate).
In `shadow` mode, compute the same verdict but return `{ autoApprove: false, shadowWouldApprove }`
so the gate logs what it *would* do without doing it.

## Config (per-gate, `node.config.confidenceGating`)

```jsonc
{
  "enabled": false,               // default off — opt-in per gate
  "minConfidence": 0.9,           // 0..1
  "maxCriticality": "MEDIUM",     // never auto-approve HIGH/CRITICAL capabilities
  "confidenceSource": "verify",   // "verify" | "context" | "both"
  "shadow": true                  // start in shadow; flip to false only after review
}
```
Global kill-switch: env `GOVERNANCE_CONFIDENCE_GATING_DISABLED=true` forces every gate back to
human review regardless of per-gate config.

## Roll it out safely

1. **Shadow first.** Ship with `shadow: true`. The gate keeps requesting human approval but
   emits `GovernanceGateWouldAutoApprove` with the confidence + risk evidence. Review those
   events: any that a human would NOT have approved is a false-auto-approve → tune thresholds.
2. **Enforce narrowly.** Flip `shadow: false` only for **low-criticality** capabilities first.
3. **Widen by evidence**, per capability, watching the auto-approval receipts.

## Audit (non-negotiable)

Every auto-approval writes a `GOVERNANCE_GATE_AUTO_APPROVED` receipt (`createReceipt`) + event
carrying the full evidence — confidence value + source, criticality, the satisfied/waived
control set, the verify verdict, and the config that allowed it. Same audit weight as a human
approval: attributable, queryable, reversible (a `GovernanceWaiver`-style revocation re-arms the
gate for future runs).

## Files

- `GovernanceGateExecutor.ts` — the guarded hook after `:634`, `recordAutoApproval`, shadow event.
- `governance/confidenceGating.ts` — **new**: `evaluateConfidenceGating` (pure, testable; the
  invariant lives in the caller, not here).
- `governance/evaluateBlock.ts` — unchanged (`decideGateStatus` still the source of truth for BLOCKED).
- config schema for `node.config.confidenceGating` + the `GOVERNANCE_CONFIDENCE_GATING_DISABLED` env.

## Tests (the safety tests are mandatory before enforce)

- Auto-approve **never** fires when `blocked.length > 0` — asserted for every `GateMode`,
  including `MANUAL_REVIEW` (which forces APPROVAL_REQUESTED even with a real block).
- Auto-approve never fires when: confidence missing/below threshold, verification failed/absent,
  criticality above the ceiling, or the kill-switch env is set.
- `shadow: true` emits the would-approve event but the node still ends `APPROVAL_REQUESTED`.
- Every auto-approval writes the `GOVERNANCE_GATE_AUTO_APPROVED` receipt.
- Property test: for random `(blocked, mode, confidence, criticality)`, the gate's final status
  is `PASSED` only if the human-review path would also have been allowed to pass (no block).
