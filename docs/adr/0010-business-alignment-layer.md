# ADR 0010: Business alignment is generated from delivery evidence

## Status

Accepted.

## Context

The platform can trace technical work down to requirements, but sponsors also
need to trace requirements upward to funded intent. Hand-maintained status
documents break that chain because they can drift from the work, approvals,
cost, schedule, and evidence held by WorkGraph.

## Decision

`SpecificationProject` remains the persisted initiative and specification root.
The user-facing term may be Initiative or Spec Package; no duplicate root model
is introduced.

Business alignment adds a thin evidence layer:

- `BusinessObjective` is tenant-scoped and can link to multiple initiatives.
- Requirements carry `objectiveRefs`; plans and WorkItems inherit objective
  lineage through their requirement subsets.
- `BusinessMilestone` declares value and target date, while status is derived
  from scheduler projections and WorkItem finalization.
- `BusinessReadout` stores generated content, citations, and its canonical
  SHA-256 digest. Sponsor approval stores the exact approved digest.
- `BusinessRisk` composes existing epistemic, design, compliance, budget,
  schedule, and drift signals. It does not create a parallel risk engine.
- `SpecificationChangeRequest` presents requirement, cost, schedule, and
  milestone consequences before sponsor review.
- `ApprovalRequest` remains the sole approval engine. Technical DRI and sponsor
  decisions are separate lanes and cannot be cast by the same actor.

MUST requirements without an objective block specification lock. SHOULD and MAY
requirements without an objective remain visible warnings. Active objectives
with no covering requirement warn during authoring and block portfolio review.

Generation planning orders otherwise-independent work by the highest objective
value score it serves, after respecting dependencies and capacity. The score is
a declared 1–5 input with rationale, not a false-precision optimizer.

## Generated communication

Sponsor and weekly readouts are immutable generated records. Every material
statement contains entity citations. Signed content is retrieved from the stored
readout rather than regenerated.

On-demand generation is always available. Scheduled weekly generation is
opt-in:

```text
BUSINESS_WEEKLY_READOUT_ENABLED=true
BUSINESS_WEEKLY_READOUT_CRON=0 8 * * 1
BUSINESS_WEEKLY_READOUT_TIMEZONE=America/New_York
```

The sponsor fast lane is controlled by deployment policy and must be agreed
with the pilot sponsor:

```text
BUSINESS_SPONSOR_COST_THRESHOLD_USD=25000
BUSINESS_SPONSOR_REQUIREMENT_THRESHOLD=5
```

An initiative requires sponsor review when either threshold is exceeded.
Otherwise the independent technical DRI lane is sufficient.

## Evidence exports

The Business Alignment surface generates:

- XLSX objective-to-evidence traceability matrix.
- XLSX spend by objective, with shared work evenly allocated across served
  objectives and unassigned work explicitly labeled.
- DOCX or PDF signed-readout archive including signer, timestamp, approval id,
  and exact content hash.
- DOCX or PDF decision log including options, rejected alternatives, and
  approval records.
- Jira-importable CSV based on explicit external taxonomy mappings.

The exports are snapshots generated from live tenant-scoped records. Their
generation time and source initiative are embedded in the document.

## External taxonomy boundary

External mappings support one-way export only. Jira or other delivery systems
do not write platform truth back into objectives, specifications, decisions, or
evidence in v1. Two-way synchronization is intentionally out of scope because
conflict resolution, external authorization, webhook replay, and field ownership
would constitute a separate program.

## Consequences

Sponsors see the same evidence spine used by delivery teams. Status, milestone
health, risk, and change consequences cannot be painted green independently of
the underlying work. Generated artifacts add storage and export-library costs,
and tenant operators must configure sponsor identities and scheduler policy.

## Rejected alternatives

- A separate portfolio engine: rejected because the required signals already
  exist in WorkGraph.
- Manually editable weekly decks: rejected because they destroy evidence
  reproducibility.
- A second approval implementation: rejected because it would split consent
  and audit semantics.
- Automatic two-way Jira sync: deferred as a separately governed integration
  program.
