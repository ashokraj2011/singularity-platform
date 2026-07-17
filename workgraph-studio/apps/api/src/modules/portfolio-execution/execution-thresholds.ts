export type ExecutionThresholds = {
  claimBlockMean: number
  claimWarningMean: number
  claimDisagreementVariance: number
  materialDrift: number
  budgetWarningPercent: number
  budgetHardCapPercent: number
}

const DEFAULTS: ExecutionThresholds = {
  claimBlockMean: 0.35,
  claimWarningMean: 0.65,
  claimDisagreementVariance: 0.05,
  materialDrift: 0.1,
  budgetWarningPercent: 80,
  budgetHardCapPercent: 120,
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function executionThresholds(env: NodeJS.ProcessEnv = process.env): ExecutionThresholds {
  const claimBlockMean = boundedNumber(env.WORKGRAPH_CLAIM_BLOCK_MEAN, DEFAULTS.claimBlockMean, 0, 1)
  const claimWarningMean = Math.max(
    claimBlockMean,
    boundedNumber(env.WORKGRAPH_CLAIM_WARNING_MEAN, DEFAULTS.claimWarningMean, 0, 1),
  )
  const budgetWarningPercent = boundedNumber(env.WORKGRAPH_BUDGET_WARNING_PERCENT, DEFAULTS.budgetWarningPercent, 1, 100)
  const budgetHardCapPercent = Math.max(
    100,
    budgetWarningPercent + 1,
    boundedNumber(env.WORKGRAPH_BUDGET_HARD_CAP_PERCENT, DEFAULTS.budgetHardCapPercent, 100, 200),
  )
  return {
    claimBlockMean,
    claimWarningMean,
    claimDisagreementVariance: boundedNumber(env.WORKGRAPH_CLAIM_DISAGREEMENT_VARIANCE, DEFAULTS.claimDisagreementVariance, 0, 1),
    materialDrift: boundedNumber(env.WORKGRAPH_MATERIAL_DRIFT_THRESHOLD, DEFAULTS.materialDrift, 0.001, 1),
    budgetWarningPercent,
    budgetHardCapPercent,
  }
}

export function deriveBudgetControl(percentUsed: number, warningPercent: number, hardCapPercent: number) {
  if (percentUsed >= hardCapPercent) return { status: 'HARD_CAP' as const, action: 'DENY_AGENT_TURNS', allowAgentTurns: false }
  if (percentUsed >= 100) return { status: 'EXCEEDED' as const, action: 'DEGRADE_TO_HUMAN_AND_REQUEST_RAISE', allowAgentTurns: false }
  if (percentUsed >= warningPercent) return { status: 'WARNING' as const, action: 'ROUTE_ECONOMY_MODEL', allowAgentTurns: true }
  return { status: 'HEALTHY' as const, action: 'ALLOW', allowAgentTurns: true }
}
