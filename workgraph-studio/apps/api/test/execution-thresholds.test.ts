import { describe, expect, it } from 'vitest'
import { deriveBudgetControl, executionThresholds } from '../src/modules/portfolio-execution/execution-thresholds'

describe('execution policy thresholds', () => {
  it('loads bounded overrides and preserves threshold ordering', () => {
    expect(executionThresholds({
      WORKGRAPH_CLAIM_BLOCK_MEAN: '0.4',
      WORKGRAPH_CLAIM_WARNING_MEAN: '0.3',
      WORKGRAPH_MATERIAL_DRIFT_THRESHOLD: '0.2',
      WORKGRAPH_BUDGET_WARNING_PERCENT: '85',
      WORKGRAPH_BUDGET_HARD_CAP_PERCENT: '80',
    })).toMatchObject({
      claimBlockMean: 0.4,
      claimWarningMean: 0.4,
      materialDrift: 0.2,
      budgetWarningPercent: 85,
      budgetHardCapPercent: 120,
    })
  })

  it('maps budget consumption to deterministic controls', () => {
    expect(deriveBudgetControl(79.9, 80, 120)).toMatchObject({ status: 'HEALTHY', allowAgentTurns: true })
    expect(deriveBudgetControl(80, 80, 120)).toMatchObject({ status: 'WARNING', action: 'ROUTE_ECONOMY_MODEL' })
    expect(deriveBudgetControl(100, 80, 120)).toMatchObject({ status: 'EXCEEDED', allowAgentTurns: false })
    expect(deriveBudgetControl(120, 80, 120)).toMatchObject({ status: 'HARD_CAP', action: 'DENY_AGENT_TURNS' })
  })
})
