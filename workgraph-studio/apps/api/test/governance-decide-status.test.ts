import { describe, it, expect } from 'vitest'
import { decideGateStatus } from '../src/modules/workflow/runtime/executors/governance/evaluateBlock'

const block = (waivable = true) => ({ controlKey: 'X', kind: 'control' as const, mode: 'BLOCKING', reason: 'r', waivable })

describe('decideGateStatus', () => {
  it('PASSED when nothing is blocked', () => {
    expect(decideGateStatus([], 'HARD_BLOCK')).toBe('PASSED')
  })
  it('WARNED in SOFT_WARN mode', () => {
    expect(decideGateStatus([block()], 'SOFT_WARN')).toBe('WARNED')
  })
  it('APPROVAL_REQUESTED in AUTOMATIC when every blocking control is waivable', () => {
    expect(decideGateStatus([block(true), block(true)], 'AUTOMATIC')).toBe('APPROVAL_REQUESTED')
  })
  it('BLOCKED in AUTOMATIC when a blocking control is not waivable', () => {
    expect(decideGateStatus([block(true), block(false)], 'AUTOMATIC')).toBe('BLOCKED')
  })
  it('BLOCKED in HARD_BLOCK mode', () => {
    expect(decideGateStatus([block()], 'HARD_BLOCK')).toBe('BLOCKED')
  })
})
