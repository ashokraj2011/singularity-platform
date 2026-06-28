import { describe, it, expect } from 'vitest'
import {
  resolveSatisfiedControls,
  controlsReferenced,
} from '../src/modules/workflow/runtime/executors/governance/resolveSatisfiedControls'

const overlay = {
  requiredEvidence: [{ evidenceKey: 'UNIT_TEST' }, { evidenceKey: 'SEC_REVIEW' }],
  blockingControls: [{ controlKey: 'REL_NOTES' }],
}

describe('resolveSatisfiedControls', () => {
  it('controlsReferenced collects required-evidence + blocking-control keys', () => {
    expect(controlsReferenced(overlay).sort()).toEqual(['REL_NOTES', 'SEC_REVIEW', 'UNIT_TEST'])
  })

  it('keeps base, adds checker-confirmed, skips unbound + unconfirmed', async () => {
    const bindings = { SEC_REVIEW: { type: 'evaluator' as const }, REL_NOTES: { type: 'artifact' as const } }
    const check = async (k: string) => k === 'SEC_REVIEW'
    const out = await resolveSatisfiedControls(overlay, bindings, new Set(['UNIT_TEST']), check)
    // UNIT_TEST from base, SEC_REVIEW from checker, REL_NOTES unconfirmed → omitted
    expect([...out].sort()).toEqual(['SEC_REVIEW', 'UNIT_TEST'])
  })

  it('a throwing checker leaves the control unsatisfied (missing-evidence policy applies)', async () => {
    const check = async () => {
      throw new Error('evidence source down')
    }
    const out = await resolveSatisfiedControls(overlay, { SEC_REVIEW: { type: 'evaluator' as const } }, new Set(), check)
    expect(out.has('SEC_REVIEW')).toBe(false)
  })

  it('does not re-check controls already in the base set', async () => {
    let calls = 0
    const check = async () => {
      calls++
      return true
    }
    await resolveSatisfiedControls(overlay, { UNIT_TEST: { type: 'receipt' as const } }, new Set(['UNIT_TEST']), check)
    expect(calls).toBe(0)
  })
})
