/**
 * Unit tests for governedFailureReason — the helper that turns a governed
 * StageRunResult into the concrete, human-readable failure reason surfaced
 * on the workbench (attempt.error → FocusPane "rework" banner).
 *
 * Regression guard for the "every failure shows the generic 'stage failed'"
 * bug: an LLM gateway upstream error (e.g. "credit balance too low") or a
 * validation/policy halt must reach the user instead of being swallowed.
 */
import { describe, it, expect } from 'vitest'
import { governedFailureReason } from '../src/modules/coding-agent/orchestrator'
import type { GovernedStageResponse } from '../src/lib/context-fabric/client'

const baseResp: GovernedStageResponse = {
  final_state: {
    stage_key: 'loop.stage',
    agent_role: 'DEVELOPER',
    current_phase: 'FINALIZE',
    repair_attempts: 0,
    receipts: {},
    history: [],
    approval_pending: false,
  },
  turns: [],
  stop_reason: 'FINALIZED',
  error_code: null,
  error_message: null,
  totals: { input_tokens: 0, output_tokens: 0, tool_calls: 0, tools_refused: 0 },
}

describe('governedFailureReason', () => {
  it('returns undefined for a clean finish (no spurious reason on success)', () => {
    expect(governedFailureReason(baseResp)).toBeUndefined()
    expect(governedFailureReason({ ...baseResp, stop_reason: 'APPROVAL_PENDING' })).toBeUndefined()
    expect(governedFailureReason({ ...baseResp, stop_reason: '' as never })).toBeUndefined()
  })

  it('surfaces the concrete LLM gateway upstream error (the real bug)', () => {
    const reason = governedFailureReason({
      ...baseResp,
      stop_reason: 'LLM_ERROR',
      error_code: 'LLM_GATEWAY_UPSTREAM_ERROR',
      error_message:
        'Gateway returned 502: {"detail":"anthropic returned 400: Your credit balance is too low to access the Anthropic API."}',
    })
    expect(reason).toContain('LLM_GATEWAY_UPSTREAM_ERROR')
    expect(reason).toContain('credit balance is too low')
  })

  it('falls back to a coded message when LLM_ERROR has no detail', () => {
    expect(
      governedFailureReason({ ...baseResp, stop_reason: 'LLM_ERROR', error_code: 'LLM_GATEWAY_TIMEOUT' }),
    ).toBe('LLM gateway error (LLM_GATEWAY_TIMEOUT)')
  })

  it('maps structural halts to readable reasons when no message is present', () => {
    expect(governedFailureReason({ ...baseResp, stop_reason: 'VALIDATION_BLOCKED' })).toBe(
      'Phase output failed validation',
    )
    expect(governedFailureReason({ ...baseResp, stop_reason: 'POLICY_BLOCKED' })).toBe(
      'Agent stalled calling disallowed tools (policy blocked)',
    )
    expect(governedFailureReason({ ...baseResp, stop_reason: 'MAX_TURNS' })).toBe(
      'Stage hit its maximum turn budget without finishing',
    )
  })

  it('prefers the concrete error_message over the stop_reason mapping', () => {
    const reason = governedFailureReason({
      ...baseResp,
      stop_reason: 'VALIDATION_BLOCKED',
      error_code: 'PLAN_RECEIPT_INVALID',
      error_message: 'missing required field target_files',
    })
    expect(reason).toBe('PLAN_RECEIPT_INVALID: missing required field target_files')
  })

  it('caps a verbose provider error so it cannot bloat the attempt record', () => {
    const reason = governedFailureReason({
      ...baseResp,
      stop_reason: 'LLM_ERROR',
      error_code: 'X',
      error_message: 'e'.repeat(2000),
    })
    expect(reason!.length).toBeLessThanOrEqual(600)
  })
})
