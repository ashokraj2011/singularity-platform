import { describe, it, expect } from 'vitest'
import { bindingsFromOverlay } from '../src/modules/workflow/runtime/executors/governance/resolveSatisfiedControls'

describe('bindingsFromOverlay (v3 overlay-owned control→evidence bindings)', () => {
  it('reads controlBindings shipped in the overlay', () => {
    const o = { controlBindings: { SEC_REVIEW: { type: 'evaluator' }, REL_NOTES: { type: 'artifact', artifactName: 'release_notes' } } }
    const m = bindingsFromOverlay(o)
    expect(m.SEC_REVIEW.type).toBe('evaluator')
    expect(m.REL_NOTES.artifactName).toBe('release_notes')
  })

  it('returns {} when the overlay has no controlBindings', () => {
    expect(bindingsFromOverlay({})).toEqual({})
    expect(bindingsFromOverlay(null)).toEqual({})
  })

  it('ignores malformed binding entries', () => {
    const m = bindingsFromOverlay({ controlBindings: { GOOD: { type: 'receipt' }, BAD: 'nope', NO_TYPE: { x: 1 } } })
    expect(Object.keys(m)).toEqual(['GOOD'])
  })
})
