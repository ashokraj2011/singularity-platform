import { describe, expect, it } from 'vitest'
import { evaluateApprovalQuorum } from '../src/lib/permissions/approval-quorum'

describe('approval quorum', () => {
  it('keeps a workflow pending until the configured positive vote quorum is met', () => {
    expect(evaluateApprovalQuorum({ decision: 'APPROVED', existingPositiveVotes: 0, quorumRequired: 2 })).toMatchObject({ decisionFinal: false, approvalsReceived: 1, quorumRequired: 2 })
    expect(evaluateApprovalQuorum({ decision: 'APPROVED', existingPositiveVotes: 1, quorumRequired: 2 }).decisionFinal).toBe(true)
  })

  it('allows an explicitly authorized admin override when configured', () => {
    expect(evaluateApprovalQuorum({ decision: 'APPROVED', existingPositiveVotes: 0, quorumRequired: 3, isAdmin: true, adminOverride: true }).decisionFinal).toBe(true)
    expect(evaluateApprovalQuorum({ decision: 'APPROVED', existingPositiveVotes: 0, quorumRequired: 3, isAdmin: true, adminOverride: false }).decisionFinal).toBe(false)
  })

  it('finalizes negative and information requests immediately', () => {
    expect(evaluateApprovalQuorum({ decision: 'REJECTED', existingPositiveVotes: 0, quorumRequired: 5 }).decisionFinal).toBe(true)
    expect(evaluateApprovalQuorum({ decision: 'NEEDS_MORE_INFORMATION', existingPositiveVotes: 0, quorumRequired: 5 }).decisionFinal).toBe(true)
  })
})
