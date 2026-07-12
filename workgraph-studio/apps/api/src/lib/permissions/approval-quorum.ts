export type ApprovalQuorumState = {
  decisionFinal: boolean
  approvalsReceived: number
  quorumRequired: number
}

export function evaluateApprovalQuorum(input: {
  decision: string
  existingPositiveVotes: number
  quorumRequired?: number
  isAdmin?: boolean
  adminOverride?: boolean
}): ApprovalQuorumState {
  const quorumRequired = Math.min(100, Math.max(1, Math.trunc(input.quorumRequired ?? 1)))
  const positive = input.decision === 'APPROVED' || input.decision === 'APPROVED_WITH_CONDITIONS'
  const approvalsReceived = input.existingPositiveVotes + (positive ? 1 : 0)
  return {
    decisionFinal: !positive || Boolean(input.isAdmin && input.adminOverride) || approvalsReceived >= quorumRequired,
    approvalsReceived,
    quorumRequired,
  }
}
