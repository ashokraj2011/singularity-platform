export interface PilotEvidence {
  ideas: number
  claims: number
  acceptedDecisions: number
  lockedSpecifications: number
  appliedPlans: number
  workItems: number
  completeChains: number
  verifiedWorkItems: number
  finalizedWorkItems: number
  learningSignals: number
  ownedFinalizationTransitions: number
  duplicateFinalizationTransitions: number
  staleReconciliations: number
  approvedWaivers: number
  failedReconciliationDriftSignals: number
  estimateActualRows: number
  adHocWorkItems: number
  budgetWarnings: number
  objectiveCoverageErrors: number
  signedSponsorReadouts: number
  consequenceChangeRequests: number
  weeklyReadouts: number
  capabilityLinks: number
  assessedCapabilityLinks: number
  adjudicatedTensions: number
  resolvedAttentionItems: number
  actionableMorningBriefs: number
  slaBreaches: number
}

export interface PilotReadinessCheck {
  key: string
  label: string
  ok: boolean
  fixRoute: string
  evidence: string
}

export function evaluatePilotReadiness(projectId: string, evidence: PilotEvidence) {
  const synthesis = (surface: string) => `/synthesis/${surface}?projectId=${encodeURIComponent(projectId)}`
  const checks: PilotReadinessCheck[] = [
    { key: 'idea', label: 'Idea or board evidence exists', ok: evidence.ideas > 0, fixRoute: synthesis('ideas'), evidence: `${evidence.ideas} durable idea/board record(s)` },
    { key: 'claim', label: 'Claims are traceable', ok: evidence.claims > 0, fixRoute: synthesis('rooms'), evidence: `${evidence.claims} claim(s)` },
    { key: 'decision', label: 'An independently accepted decision exists', ok: evidence.acceptedDecisions > 0, fixRoute: synthesis('decisions'), evidence: `${evidence.acceptedDecisions} accepted dossier(s)` },
    { key: 'spec', label: 'A specification is locked', ok: evidence.lockedSpecifications > 0, fixRoute: synthesis('generate'), evidence: `${evidence.lockedSpecifications} locked/active specification(s)` },
    { key: 'plan', label: 'A generation plan was applied', ok: evidence.appliedPlans > 0, fixRoute: synthesis('generate'), evidence: `${evidence.appliedPlans} applied plan(s)` },
    { key: 'lineage', label: 'Every generated WorkItem has a complete evidence chain', ok: evidence.workItems > 0 && evidence.completeChains === evidence.workItems, fixRoute: synthesis('spec'), evidence: `${evidence.completeChains}/${evidence.workItems} complete chain(s)` },
    { key: 'transition-owner', label: 'Authoritative completion transitions have one owner', ok: evidence.ownedFinalizationTransitions > 0 && evidence.duplicateFinalizationTransitions === 0, fixRoute: '/work-items', evidence: `${evidence.ownedFinalizationTransitions} owned transition(s), ${evidence.duplicateFinalizationTransitions} duplicate(s)` },
    { key: 'stale-fence', label: 'A stale submission or reconciliation was fenced', ok: evidence.staleReconciliations > 0, fixRoute: '/work-items', evidence: `${evidence.staleReconciliations} stale reconciliation(s)` },
    { key: 'waiver', label: 'A governed waiver was recorded', ok: evidence.approvedWaivers > 0, fixRoute: '/work-items', evidence: `${evidence.approvedWaivers} approved waiver(s)` },
    { key: 'verified', label: 'Dynamic reconciliation verified delivery', ok: evidence.verifiedWorkItems > 0, fixRoute: '/work-items', evidence: `${evidence.verifiedWorkItems} verified WorkItem(s)` },
    { key: 'finalized', label: 'The Finalizer completed delivery authoritatively', ok: evidence.finalizedWorkItems > 0, fixRoute: '/work-items', evidence: `${evidence.finalizedWorkItems} finalized WorkItem(s)` },
    { key: 'posterior', label: 'Failed reconciliation moved a claim posterior', ok: evidence.failedReconciliationDriftSignals > 0, fixRoute: synthesis('learning'), evidence: `${evidence.failedReconciliationDriftSignals} failed-run drift signal(s)` },
    { key: 'learning', label: 'Reconciliation evidence closed the claim loop', ok: evidence.learningSignals > 0, fixRoute: synthesis('learning'), evidence: `${evidence.learningSignals} learning signal(s)` },
    { key: 'actuals', label: 'Plan estimates are paired with delivery actuals', ok: evidence.estimateActualRows > 0, fixRoute: synthesis('economics'), evidence: `${evidence.estimateActualRows} estimate/actual row(s)` },
    { key: 'fast-lane', label: 'The AD_HOC fast lane was exercised', ok: evidence.adHocWorkItems > 0, fixRoute: '/work-items', evidence: `${evidence.adHocWorkItems} AD_HOC WorkItem(s)` },
    { key: 'budget-warning', label: 'A real budget warning was recorded', ok: evidence.budgetWarnings > 0, fixRoute: synthesis('economics'), evidence: `${evidence.budgetWarnings} warning event(s)` },
    { key: 'objective-coverage', label: 'Objective orphan checks pass', ok: evidence.objectiveCoverageErrors === 0, fixRoute: synthesis('business'), evidence: `${evidence.objectiveCoverageErrors} blocking coverage error(s)` },
    { key: 'sponsor-readout', label: 'A sponsor readout is signed', ok: evidence.signedSponsorReadouts > 0, fixRoute: synthesis('business'), evidence: `${evidence.signedSponsorReadouts} signed sponsor readout(s)` },
    { key: 'change-consequences', label: 'A change request records delivery consequences', ok: evidence.consequenceChangeRequests > 0, fixRoute: synthesis('business'), evidence: `${evidence.consequenceChangeRequests} consequence-priced change request(s)` },
    { key: 'weekly-readouts', label: 'Two weekly readouts were generated', ok: evidence.weeklyReadouts >= 2, fixRoute: synthesis('business'), evidence: `${evidence.weeklyReadouts}/2 weekly readout(s)` },
    { key: 'capability-heatmap', label: 'Capability impact links are assessed', ok: evidence.capabilityLinks > 0 && evidence.assessedCapabilityLinks >= evidence.capabilityLinks, fixRoute: synthesis('hub'), evidence: `${evidence.assessedCapabilityLinks}/${evidence.capabilityLinks} capability link(s) assessed` },
    { key: 'contradiction', label: 'A real source contradiction was human-adjudicated', ok: evidence.adjudicatedTensions > 0, fixRoute: synthesis('intake'), evidence: `${evidence.adjudicatedTensions} adjudicated tension(s)` },
    { key: 'desk-calibration', label: 'Desk ranking has enough human feedback to calibrate', ok: evidence.resolvedAttentionItems >= 5, fixRoute: synthesis('desk'), evidence: `${evidence.resolvedAttentionItems}/5 resolved attention item(s)` },
    { key: 'morning-brief', label: 'An actionable cited morning brief exists', ok: evidence.actionableMorningBriefs > 0, fixRoute: synthesis('desk'), evidence: `${evidence.actionableMorningBriefs} actionable morning brief(s)` },
    { key: 'sla', label: 'SLA enforcement is evidenced', ok: evidence.slaBreaches > 0, fixRoute: '/work-items', evidence: `${evidence.slaBreaches} SLA breach event(s)` },
  ]
  return {
    ready: checks.every(check => check.ok),
    score: Math.round(checks.filter(check => check.ok).length / checks.length * 100),
    checks,
  }
}
