# Contract-Bound Work Execution

## Control statement

Completion has one owner, verification has one authority, and specification approval has separation of duties.

- `WorkItemFinalizer` is the only component allowed to set a WorkItem to `COMPLETED`.
- Dynamic reconciliation is the only path that can produce `VERIFIED_PASS` and set evidence to `VERIFIED`.
- Deterministic and semantic reconciliation are advisory and never complete a WorkItem.
- A specification author cannot approve their own version.
- A new implementation submission makes older reconciliation runs for the same delivery scope `STALE`.
- Finalization accepts verification only for the latest submission, current binding, and current handoff generation.
- Expired runner leases are requeued or dead-lettered when their retry budget is exhausted.
- Decision authors cannot approve their own decision dossiers; rejected options remain durable evidence.
- Generation binds each WorkItem to a locked specification version, claim/decision lineage, and a deterministic schedule.
- WorkItem SLA breaches are emitted once and protected by a database uniqueness fence.

The executable control checks live in:

- `workgraph-studio/apps/api/test/execution-hardening.test.ts`
- `workgraph-studio/apps/api/test/reconciliation-completion-gate.test.ts`
- `workgraph-studio/apps/api/test/reconciliation-dynamic.test.ts`
- `workgraph-studio/apps/api/test/workflow-authorization-hardening.contract.test.ts`
- `workgraph-studio/apps/api/test/contract-bound-execution.integration.test.ts`
- `workgraph-studio/apps/api/test/generation-scheduler.test.ts`

## Evidence lifecycle

1. An approved specification is resolved into an immutable WorkItem binding.
2. A DevelopmentScope publishes a pinned handoff generation.
3. Each check-in creates an immutable ImplementationSubmission.
4. Registering a newer submission invalidates earlier reconciliation evidence for that scope.
5. Deterministic and semantic passes may add findings but remain `NOT_VERIFIED`.
6. A fenced dynamic runner can produce `VERIFIED_PASS`; skipped-only plans cannot.
7. Independent approval and the current verified evidence are submitted to `WorkItemFinalizer`.

## Synthesis-to-execution chain

Synthesis now exposes the governed handoff:

1. `/synthesis/ideas` and `/synthesis/rooms` establish evidence-backed claims.
2. `/synthesis/options` preserves alternatives and their effort, cost, token, and risk estimates.
3. `/synthesis/decisions` packages alternatives into an independently approved decision dossier.
4. `/synthesis/spec` traces claims into requirements.
5. `/synthesis/generate` compiles a canonical, hashed specification version and creates a generation plan.
6. Plan validation checks requirement coverage, decision and claim lineage, dependency cycles, budget limits, and projected dates.
7. Plan apply idempotently creates `SPEC_GENERATED` WorkItems, bindings, DevelopmentScopes, and HandoffGenerations.
8. Dynamic reconciliation feeds experiment-tier evidence back into the linked claims.
9. `/synthesis/economics` compares planned cost with the model token ledger and shows the critical path.

The governing records are `DecisionDossier`, `DecisionOption`, `SpecificationVersion`, `GenerationPlan`, `GenerationPlanRow`, `ProjectBudgetEnvelope`, and `ProjectTokenLedgerEntry`.

## Operational verification

```bash
cd workgraph-studio
pnpm --filter @workgraph/api build
pnpm --filter @workgraph/api test
pnpm --filter web build

cd ../agent-and-tools
npm run build --workspace=web
```

Run the lifecycle integration suite with an isolated, migrated PostgreSQL database in `DATABASE_URL` and `TEST_DATABASE_URL`. It covers fresh-run fencing, stale submission invalidation, specification and decision approval separation of duties, and SLA event uniqueness.

## Residual pilot work

- Capacity calendars currently refine planning outside the pure scheduler; per-person availability and holiday calendars are not yet inputs to generation validation.
- Budget envelopes enforce plan thresholds, while automatic model rerouting by remaining budget is policy-driven rather than optimizer-driven.
- Production feedback remains outside the declared scope. The production evidence tier is reserved for that later expansion.
