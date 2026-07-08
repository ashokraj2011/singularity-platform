import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Guards the High-severity hardening of the pending-execution runner protocol
// (CLIENT/EDGE/EXTERNAL queue). Claim must be an atomic single-winner; complete
// must be gated by the claimToken and be single-shot; the token must never leak
// through the list/poll surfaces. A regression here re-opens duplicate-run and
// cross-runner-overwrite holes, so these are asserted at the source level (the
// routes need a live DB to exercise behaviorally).
const router = fs.readFileSync(
  path.join(process.cwd(), 'src/modules/workflow/instances.router.ts'),
  'utf8',
)

describe('pending-execution claim/complete safety contract', () => {
  it('claim is atomic: only an unclaimed, uncompleted, unexpired row can be taken', () => {
    expect(router).toMatch(
      /pendingExecution\.updateMany\(\{[\s\S]*?where: \{ id: req\.params\.execId, claimedAt: null, completedAt: null, expiresAt: \{ gt: new Date\(\) \} \}/,
    )
  })

  it('claim mints a fresh claimToken and 409s the loser', () => {
    expect(router).toMatch(/const claimToken = randomUUID\(\)/)
    expect(router).toMatch(/claimed\.count !== 1[\s\S]*?res\.status\(409\)/)
  })

  it('complete requires a claimToken', () => {
    expect(router).toMatch(/if \(!claimToken \|\| typeof claimToken !== 'string'\)[\s\S]*?claimToken is required/)
  })

  it('complete is token-gated and single-shot, 409 otherwise', () => {
    expect(router).toMatch(
      /pendingExecution\.updateMany\(\{[\s\S]*?where: \{ id: req\.params\.execId, claimToken, completedAt: null \}/,
    )
    expect(router).toMatch(/done\.count !== 1[\s\S]*?res\.status\(409\)/)
  })

  it('never leaks claimToken through the list or poll surfaces', () => {
    const strips = router.match(/claimToken: _claimToken, \.\.\.rest/g) ?? []
    // one in the per-instance list endpoint, one in the cross-instance poll endpoint
    expect(strips.length).toBeGreaterThanOrEqual(2)
  })
})
