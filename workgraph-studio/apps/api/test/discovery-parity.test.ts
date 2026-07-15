/**
 * Discovery gate parity (ADR 0006 Slice 4).
 *
 * The DISCOVERY gate exists in two places that MUST agree so a workflow behaves
 * identically whether it runs on the server runtime or the portable @workgraph/vm:
 *   - Server: WorkflowRuntime advances the node iff the session is not BLOCKED,
 *     where computeSessionStatus() returns BLOCKED iff a blocking question is OPEN.
 *   - VM:     discoveryExecutor parks (BLOCKED) iff hasBlockingOpen() is true.
 *
 * This test imports BOTH real implementations (no re-declaration) and asserts
 * they make the same park/advance decision across a matrix of question sets,
 * plus that seed-question mapping (required|blocking → gate) is identical.
 */
import { describe, it, expect } from 'vitest'
import { computeSessionStatus } from '../src/modules/discovery/discovery.service'
// Cross-package: the real portable VM gate. Vitest resolves the .ts source.
import { hasBlockingOpen, readSeedQuestions } from '../../../packages/vm/src/executors/discovery'

type QStatus = 'OPEN' | 'ANSWERED' | 'DISMISSED'
type Q = { blocking: boolean; status: QStatus }

/** True when the SERVER runtime would park a DISCOVERY node for this set. */
const serverParks = (qs: Q[]) => computeSessionStatus('OPEN', qs) === 'BLOCKED'
/** True when the VM discoveryExecutor would park (BLOCK) for this set. */
const vmParks = (qs: Q[]) => hasBlockingOpen(qs.map(q => ({ text: 'q', blocking: q.blocking, status: q.status })))

const CASES: { name: string; qs: Q[]; parks: boolean }[] = [
  { name: 'empty set → advance', qs: [], parks: false },
  { name: 'single blocking OPEN → park', qs: [{ blocking: true, status: 'OPEN' }], parks: true },
  { name: 'blocking ANSWERED → advance', qs: [{ blocking: true, status: 'ANSWERED' }], parks: false },
  { name: 'blocking DISMISSED → advance', qs: [{ blocking: true, status: 'DISMISSED' }], parks: false },
  { name: 'non-blocking OPEN → advance', qs: [{ blocking: false, status: 'OPEN' }], parks: false },
  { name: 'blocking OPEN + non-blocking OPEN → park', qs: [{ blocking: true, status: 'OPEN' }, { blocking: false, status: 'OPEN' }], parks: true },
  { name: 'blocking ANSWERED + blocking OPEN → park', qs: [{ blocking: true, status: 'ANSWERED' }, { blocking: true, status: 'OPEN' }], parks: true },
  { name: 'all resolved → advance', qs: [{ blocking: true, status: 'ANSWERED' }, { blocking: false, status: 'DISMISSED' }], parks: false },
]

describe('DISCOVERY gate — server vs VM parity', () => {
  for (const c of CASES) {
    it(`${c.name}`, () => {
      expect(serverParks(c.qs)).toBe(c.parks)
      expect(vmParks(c.qs)).toBe(c.parks)
      // The core parity invariant: both engines agree for every input.
      expect(serverParks(c.qs)).toBe(vmParks(c.qs))
    })
  }

  it('seed-question mapping agrees: required|blocking both gate, neither does not', () => {
    const seeds = readSeedQuestions({
      questions: [
        { text: 'required flag', required: true },
        { text: 'blocking flag', blocking: true },
        { text: 'optional', required: false },
        { text: 'bare' },
      ],
    })
    // VM readSeedQuestions marks required OR blocking as gating — same rule the
    // server bridge (seedSessionQuestions: required → blocking) applies.
    expect(seeds.map(s => s.blocking)).toEqual([true, true, false, false])

    // Offline VM parks iff a seed question gates — mirror of the server node
    // seeding blocking questions → session BLOCKED → node parks.
    const anyBlockingSeed = seeds.some(s => s.blocking)
    expect(hasBlockingOpen(seeds)).toBe(anyBlockingSeed)
    const asServer: Q[] = seeds.map(s => ({ blocking: s.blocking, status: 'OPEN' }))
    expect(serverParks(asServer)).toBe(anyBlockingSeed)
  })
})
