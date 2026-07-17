import { evaluatePilotReadiness, type PilotEvidence } from '../src/modules/portfolio-execution/pilot-readiness'

const completeEvidence: PilotEvidence = {
  ideas: 1,
  claims: 2,
  acceptedDecisions: 1,
  lockedSpecifications: 1,
  appliedPlans: 1,
  workItems: 2,
  completeChains: 2,
  verifiedWorkItems: 1,
  finalizedWorkItems: 1,
  learningSignals: 1,
  ownedFinalizationTransitions: 1,
  duplicateFinalizationTransitions: 0,
  staleReconciliations: 1,
  approvedWaivers: 1,
  failedReconciliationDriftSignals: 1,
  estimateActualRows: 1,
  adHocWorkItems: 1,
  budgetWarnings: 1,
  objectiveCoverageErrors: 0,
  signedSponsorReadouts: 1,
  consequenceChangeRequests: 1,
  weeklyReadouts: 2,
  capabilityLinks: 2,
  assessedCapabilityLinks: 2,
  adjudicatedTensions: 1,
  resolvedAttentionItems: 5,
  actionableMorningBriefs: 1,
  slaBreaches: 1,
}

describe('Master Design pilot readiness', () => {
  it('is ready only when every durable proof obligation is met', () => {
    const result = evaluatePilotReadiness('project-1', completeEvidence)
    expect(result.ready).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(25)
    expect(result.checks.every(check => check.evidence.length > 0)).toBe(true)
  })

  it('fails closed for missing sponsor, contradiction, and stale-fence evidence', () => {
    const result = evaluatePilotReadiness('project-1', {
      ...completeEvidence,
      signedSponsorReadouts: 0,
      adjudicatedTensions: 0,
      staleReconciliations: 0,
    })
    expect(result.ready).toBe(false)
    expect(result.checks.filter(check => !check.ok).map(check => check.key)).toEqual([
      'stale-fence',
      'sponsor-readout',
      'contradiction',
    ])
  })

  it('does not accept duplicate authoritative finalization transitions', () => {
    const result = evaluatePilotReadiness('project-1', { ...completeEvidence, duplicateFinalizationTransitions: 1 })
    expect(result.checks.find(check => check.key === 'transition-owner')?.ok).toBe(false)
  })
})
