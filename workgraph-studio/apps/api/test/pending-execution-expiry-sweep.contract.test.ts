import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Guards the pending-execution expiry sweep: if no runner claims/completes a queued
// non-SERVER node, the row expires (expiresAt) and the node must FAIL, not stall
// ACTIVE forever. Asserted at source level (the sweep needs a live cross-tenant DB
// to exercise).
const sweep = fs.readFileSync(
  path.join(process.cwd(), 'src/modules/workflow/runtime/TimerSweep.ts'),
  'utf8',
)

describe('pending-execution expiry sweep contract', () => {
  it('discovers only expired, uncompleted rows', () => {
    expect(sweep).toMatch(
      /pendingExecution\.findMany\(\{[\s\S]*?where: \{ completedAt: null, expiresAt: \{ lt: now \} \}/,
    )
  })

  it('marks the row completed before failing the node (so it is not re-swept)', () => {
    expect(sweep).toMatch(
      /pendingExecution\.update\(\{[\s\S]*?data: \{ completedAt: now, error: reason \}[\s\S]*?failNode\(/,
    )
  })

  it('fails the node only when node and instance are still ACTIVE', () => {
    expect(sweep).toMatch(
      /row\.instance\?\.status === 'ACTIVE' && row\.node\?\.status === 'ACTIVE'[\s\S]*?failNode\(row\.instanceId, row\.nodeId, \{ message: reason, code: 'PENDING_EXECUTION_EXPIRED' \}/,
    )
  })

  it('uses the cross-tenant sweepReader for discovery but tenant-scoped writes', () => {
    expect(sweep).toMatch(/sweepReader\.pendingExecution\.findMany/)
    expect(sweep).toMatch(/withTenantDbTransaction\(prisma, \(tx\) => tx\.pendingExecution\.update/)
  })
})
