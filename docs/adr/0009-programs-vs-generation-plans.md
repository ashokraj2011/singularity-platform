# ADR 0009: Programs and generation plans have separate responsibilities

## Status

Accepted.

## Context

Both Programs and Generation Plans can lead to WorkItems. Without a clear
boundary they become competing orchestration models, with unclear ownership of
dependencies, estimates, retries, and evidence.

## Decision

Programs and Generation Plans remain distinct:

- A **Program** is a reusable operational automation. It reacts to a lifecycle
  event and starts configured workflows or follow-up work. It owns trigger,
  fanout, and completion-program behavior.
- A **Generation Plan** is a reviewed, immutable decomposition of one locked
  specification version. It owns requirement coverage, WorkItem rows,
  dependencies, capacity-aware dates, estimates, and specification lineage.

Applying a Generation Plan may associate generated WorkItems with a Program,
but a Program cannot manufacture or replace specification lineage. Replanning
an applied plan requires a versioned `GenerationPlanAmendment`; it cannot edit
the original rows in place.

## Invariants

- Plan application is idempotent per plan row.
- Every generated WorkItem has a current binding, scope, and handoff generation.
- Capacity allocations are created from validated plan rows.
- Actual dates, hours, and cost are recorded against the generated row and its
  allocation.
- Date changes after apply require independent amendment approval.
- Program execution can be retried without duplicating generation rows.
- WorkItem completion remains owned by `WorkItemFinalizer`, regardless of the
  Program that launched downstream work.

## Consequences

Reusable automation stays simple, while specification-driven delivery remains
auditable and reproducible. The UI can explain whether a WorkItem exists because
of a contract decomposition or an operational event instead of blending both
origins.

## Rejected alternatives

- Reusing Programs as generation plans: rejected because event automation does
  not carry immutable requirement coverage or scheduling review.
- Reusing Generation Plans as long-running workflow orchestration: rejected
  because plans should remain stable evidence, not mutable runtime state.
