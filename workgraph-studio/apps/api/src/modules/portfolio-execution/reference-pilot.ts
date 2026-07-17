import type { PilotEvidence } from './pilot-readiness'

export const REFERENCE_PILOT_PROJECT_ID = '9f000000-0000-4000-8000-000000000001'
export const REFERENCE_PILOT_CODE = 'REF-PILOT-001'
export const REFERENCE_PILOT_TAGS = ['reference-pilot', 'synthetic-evidence'] as const

export type PilotEvidenceMode = 'REFERENCE_SYNTHETIC' | 'LIVE'

export function pilotEvidenceMode(tags: string[]): PilotEvidenceMode {
  return REFERENCE_PILOT_TAGS.every(tag => tags.includes(tag)) ? 'REFERENCE_SYNTHETIC' : 'LIVE'
}

/**
 * The minimum durable evidence emitted by the reference-pilot runner. Keeping
 * this manifest beside the evaluator makes drift between the fixture and the
 * proof contract visible in tests.
 */
export const REFERENCE_PILOT_EXPECTED_EVIDENCE: PilotEvidence = {
  ideas: 1,
  claims: 1,
  acceptedDecisions: 1,
  lockedSpecifications: 1,
  appliedPlans: 1,
  workItems: 1,
  completeChains: 1,
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
  capabilityLinks: 1,
  assessedCapabilityLinks: 1,
  adjudicatedTensions: 1,
  resolvedAttentionItems: 5,
  actionableMorningBriefs: 1,
  slaBreaches: 1,
}
