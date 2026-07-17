# ADR 0008: Synthesis pipeline convergence and evidence lineage

## Status

Accepted.

## Context

Ideas, claims, decisions, specifications, generated WorkItems, implementation
evidence, and production learning previously existed as useful but weakly
connected records. Operators could complete each surface without proving that
the final delivery still represented the original intent.

## Decision

Synthesis owns one governed convergence pipeline:

`Idea evidence -> Claims -> Decision dossier -> Locked specification -> Generation plan -> WorkItems -> Dynamic reconciliation -> Learning`

The durable rules are:

- Every accepted decision preserves its rejected alternatives.
- Every generated plan row carries claim, decision, and requirement references.
- Applying a plan creates an immutable specification binding, development
  scope, and handoff generation for each WorkItem.
- Dynamic reconciliation is the only implementation check allowed to produce
  `VERIFIED_PASS`.
- Reconciliation evidence is folded back into the claims that justified the
  affected requirements.
- Material negative belief movement creates a governed specification change
  request; it never silently edits an approved specification.
- `traceId` is the cross-service evidence key from workflow execution through
  reconciliation, drift, change control, events, and audit.

`GET /api/portfolio/projects/:projectId/traceability` is the canonical read
model for this lineage. It is an aggregation, not a second source of truth.

## Consequences

- A delivery can be inspected in either direction: idea-to-check-in or failed
  verification-to-governing assumption.
- Evidence gaps are visible as missing graph edges and pilot-readiness checks.
- Thresholds are centrally configured by the execution-threshold policy; UI
  code does not decide whether evidence is sufficient.
- Approved contracts stay immutable. Change happens by reviewed request and a
  new specification generation.

## Rejected alternatives

- A separate traceability database: rejected because it would duplicate
  ownership and require reconciliation with the transactional records.
- Automatically rewriting the specification after a failed check: rejected
  because it bypasses human accountability and separation of duties.
- Treating deterministic or semantic review as delivery proof: rejected
  because neither executes the implementation.
