/**
 * Unit tests for the Studio Board AgentVerdicts pure core (PR-5): the parse-time
 * contracts (citation rule + tone contract) and the lifecycle state machine. DB-free.
 */
import { describe, it, expect } from 'vitest'
import { verdictInputSchema, nextVerdictStatus, isTerminal } from '../src/modules/studio/board-verdicts'

const base = { targetType: 'CLAIM', targetRef: 'claim-402', rationale: 'volume forecast contradicts the spike sticky', evidenceRefs: ['ev-30'] }

describe('verdictInputSchema — citation rule + tone contract', () => {
  it('accepts an ENDORSE with >=1 evidence ref', () => {
    const v = verdictInputSchema.parse({ ...base, stance: 'ENDORSE' })
    expect(v.stance).toBe('ENDORSE')
    expect(v.confidence).toBe(0.6) // default
  })
  it('REJECTS any verdict with no evidence refs (citation rule)', () => {
    expect(() => verdictInputSchema.parse({ ...base, stance: 'FLAG', evidenceRefs: [] })).toThrow()
  })
  it('REJECTS a CHALLENGE that does not say what would resolve it (tone contract)', () => {
    expect(() => verdictInputSchema.parse({ ...base, stance: 'CHALLENGE' })).toThrow()
    const ok = verdictInputSchema.parse({ ...base, stance: 'CHALLENGE', resolvesWith: 'a run of the month-end load test' })
    expect(ok.resolvesWith).toContain('load test')
  })
  it('does not require resolvesWith for ENDORSE / FLAG', () => {
    expect(() => verdictInputSchema.parse({ ...base, stance: 'ENDORSE' })).not.toThrow()
    expect(() => verdictInputSchema.parse({ ...base, stance: 'FLAG' })).not.toThrow()
  })
  it('rejects unknown stance / target type', () => {
    expect(() => verdictInputSchema.parse({ ...base, stance: 'VETO', resolvesWith: 'x' })).toThrow()
    expect(() => verdictInputSchema.parse({ ...base, targetType: 'GALAXY', stance: 'FLAG' })).toThrow()
  })
})

describe('nextVerdictStatus — lifecycle', () => {
  it('allows the valid transitions', () => {
    expect(nextVerdictStatus('OPEN', 'answer')).toBe('ANSWERED')
    expect(nextVerdictStatus('OPEN', 'dismiss')).toBe('DISMISSED')
    expect(nextVerdictStatus('ANSWERED', 'concede')).toBe('CONCEDED')
    expect(nextVerdictStatus('DISMISSED', 'reopen')).toBe('OPEN')
  })
  it('returns null for invalid transitions', () => {
    expect(nextVerdictStatus('CONCEDED', 'answer')).toBeNull()
    expect(nextVerdictStatus('OPEN', 'reopen')).toBeNull()
    expect(nextVerdictStatus('DISMISSED', 'dismiss')).toBeNull()
  })
})

describe('isTerminal', () => {
  it('marks resolved states terminal', () => {
    expect(isTerminal('CONCEDED')).toBe(true)
    expect(isTerminal('DISMISSED')).toBe(true)
    expect(isTerminal('EXPIRED')).toBe(true)
    expect(isTerminal('OPEN')).toBe(false)
    expect(isTerminal('ANSWERED')).toBe(false)
  })
})
