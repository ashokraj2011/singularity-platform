# Singularity Program Master Design v2

This document is the program index for the path from idea to verified check-in.
It supersedes earlier end-to-end plans as the top-level map; detailed contracts
remain in the linked architecture and ADR documents. Post-production learning is
outside the current boundary. The `PRODUCTION` evidence tier is reserved for it.

## Program Invariants

1. One owner per transition. Only `WorkItemFinalizer` completes work, only reconciliation verifies delivery, and only compilation locks a specification.
2. Agents propose; humans commit. Agent endorsement or challenge is evidence and never changes a human-owned artifact by itself.
3. Agents may develop initiatives, but judgment remains human. Requirements are earned from evidence, never scaffolded as facts.
4. Agent-authored narratives are citation-or-rejection. Every sentence must resolve to durable source entities or source spans.
5. Evidence tiers are honest. Imported documents stop at `SOURCE_DOCUMENT`; executed reconciliation emits `EXPERIMENT`; opinion has no verification effect.
6. Gates start advisory and harden by policy. Every block is waivable only by an authorized DRI or sponsor with a recorded reason.
7. Passing gates stay quiet. Operators see ranked exceptions, not green checklists.
8. Human attention has economics: `stakes * uncertainty * urgency`. The long tail is digested or auto-confirmed; expiry is not rejection.
9. `AD_HOC` is a legitimate fast lane with the same reconciliation guarantees and lighter ceremony.
10. Users work with five verbs: idea, question, choice, plan, and work. Internal ontology remains implementation detail.

## Workstreams

### A. Execution hardening

Contract-bound execution, one completion owner, leased reconciliation runners,
rework fencing, specification separation of duties, stale generation guards,
latest-submission invalidation, and explicit cancellation. Legacy WorkItem routes
must retain per-item authorization until they are retired.

### B. Pipeline merge

Claim and option convergence flows into decision dossiers, compile-and-lock,
generation plans, handoffs, reconciliation evidence, posterior drift, and governed
change requests. The complete chain must remain navigable in both directions.

### C. Economics

Token and cost lineage, budget envelopes and enforcement ladders, model routing,
plan estimates, capacity scheduling, due dates, SLA signals, and amendment-based
replanning. Budget enforcement must never strand a human action.

### D. Business alignment and capability anchoring

Objectives justify requirements; initiatives carry one primary capability plus
supporting/consumed capability relationships; claims are capability-tagged.
Sponsor consent signs a generated, hash-addressed readout. Milestones are derived,
risks are composed from durable signals, and change requests present consequences
rather than raw diffs. Exports are one-way and auditable.

### E. Experience and agentic intake

The Desk projects all human attention into four bands: `BLOCKING`, `DECIDE`,
`REVIEW`, and `DIGEST`. Ranking is legible and bounded by a daily review budget.

The intake interview follows five stages: `PROBLEM`, `BELIEFS`, `SUCCESS`,
`CONSTRAINTS`, and `CONTEXT`. Each turn is read back before progression. An
interrupted interview can produce one governed scaffold proposal containing an
initiative update, board/room structure, claims with evidence, probes, draft
objectives, and an empty-requirements specification skeleton.

Artifact intake recognizes a document pile, validates completeness and
consistency, creates span-cited tensions for contradictions, and emits one cited
validation report. Transmutation creates drafts at the `SOURCE_DOCUMENT` ceiling;
it never silently accepts a claim or locks a requirement.

The overnight shift runs bounded deterministic sweeps first, ranks optional work
by expected value per cost, respects the project budget, and never touches locked,
challenged, or recently human-edited artifacts. Its morning brief is immutable,
role-shaped, spend-disclosed, no more than eight sentences, and citation-or-reject.

## Canonical Entity Ownership

- `SpecificationProject`: initiative/specification root.
- `ProjectSpecification`: editable specification buffer.
- `SpecificationVersion`: immutable compiled package.
- `StudioProposal`: all agent-authored proposal batches, including intake and artifact scaffolds.
- `AttentionItem`: projection and calibration record; never a replacement source of truth.
- `IngestedArtifact` plus `ArtifactValidationReport`: source pile and cited validation result.
- `ProjectTokenLedgerEntry` and `ProjectBudgetEnvelope`: cost truth.
- `BusinessReadout`: immutable sponsor, weekly, and morning communication.
- `SpecificationProjectCapability`: primary, impacted, supporting, consumed, or proposed capability relation.
- `Claim.capabilityId`: capability ownership of a belief.

## Pilot Acceptance

The pilot must demonstrate one owner per transition, stale submission fencing,
full-chain traceability, recorded waivers, posterior movement after failed
reconciliation, estimates versus actuals, the `AD_HOC` lane, budget warning,
objective orphan checks, signed sponsor readout, consequence-based change request,
two generated weekly readouts, capability heatmap, a real artifact contradiction
adjudicated by a human decision, Desk calibration, and an actionable cited morning
brief. Passing UI alone is not evidence.

## Related Documents

- [Contract-bound work execution](contract-bound-work-execution.md)
- [Concept archive](concept-archive.md)
- [Confidence-gated autonomy](confidence-gated-autonomy.md)
- [ADR 0008: synthesis pipeline convergence](adr/0008-synthesis-pipeline-convergence.md)
- [ADR 0009: programs and generation plans](adr/0009-programs-vs-generation-plans.md)
- [ADR 0010: business alignment layer](adr/0010-business-alignment-layer.md)
