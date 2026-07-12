# Roadmap Gap Closure

This slice turns the roadmap items for workflow operations, collaboration,
governance, capacity, runtime safety, and independent verification into
tenant-scoped WorkGraph contracts. The migration is
`20260713100000_roadmap_gap_closure` and is applied by the bare-metal launcher
after `prisma db push`.

## Workflow debugging

Simulation remains side-effect free. `POST /api/workflows/:templateId/simulate`
returns the predicted path, agent/model work, tools, approvals, guarded side
effects, estimated tokens/cost/duration, and unresolved human actions. It does
not create a workflow run or invoke a provider.

The authenticated debug surface is:

- `POST /api/workflow-debug/instances/:id/clone`
- `GET|POST /api/workflow-debug/instances/:id/time-travel`
- `GET /api/workflow-debug/instances/:id/compensations`
- `POST /api/workflow-debug/instances/:id/nodes/:nodeId/compensate`
- `POST /api/workflow-debug/templates/:id/migrations/preview`
- `POST /api/workflow-debug/templates/:id/migrations`
- `GET /api/workflow-debug/templates/:id/migrations`

Run clones are draft, isolated instances. Time-travel snapshots preserve the
checkpoint context/node state plus routing decisions, prompt references,
policy snapshot, and artifact event references. Template migration is explicit:
the operator supplies an old-node to new-node map and receives warnings before
applying it to active, paused, or draft runs. Compensation is allow-listed to
`LOG`, `EMIT_EVENT`, and `RESTORE_CONTEXT`; arbitrary shell or webhook execution
is intentionally not accepted by this endpoint.

## Collaboration and attention management

`/api/collaboration` provides durable comments with mention extraction,
notification preferences, subscriptions, out-of-office delegation, notification
delivery retry, and notification audit history. Notifications remain visible
across browsers because state is stored in WorkGraph, not only local storage.
Delivery rows are created for `IN_APP`, `EMAIL`, `SLACK`, `TEAMS`, `WEBHOOK`, or
`MOBILE`; channel workers can claim pending rows without changing workflow
execution. A delivery retry never re-runs a workflow.

Approval authorization honors active, time-bounded `DIRECT_USER` out-of-office
delegations. Delegation does not grant admin permission and does not widen
role-, skill-, team-, or capability-scoped approvals.

## Enforceable governance

Governance policies are versioned and support staged modes:

- `ADVISORY`: records a warning and permits progress.
- `REQUIRED`: blocks until required evidence is present or a valid waiver exists.
- `BLOCKING`: blocks promotion/execution until evidence or waiver is present.

Use `/api/governance/policies` to author, version, activate, preview, evaluate,
and inspect coverage. Active policies are evaluated by `GOVERNANCE_GATE` nodes
alongside IAM overlays and are written to `governance_policy_evaluations`.
Every evaluation retains the policy version, evidence, checks, missing keys,
and result, so later policy edits do not rewrite history.

## Capacity-aware planning

`/api/planning/capacity` supports user/team/capability calendars, weekly hours,
holidays, WIP limits, allocations, and scenario forecasts. Forecast results
include effort, available capacity, utilization, predicted completion days,
conflicts, and critical-path risk. The planner can attach a `plannerSessionId`
to preserve the scenario that produced the forecast.

## Runtime safety

`/api/runtime-policy` provides tenant-owned runtime policies and device
enrollment. Policies hold allowed workspace paths, consent mode, minimum version,
auto-update, and a kill switch; secrets and JWTs remain outside the database.
The `/check` endpoint fails closed for revoked devices, kill switches, paths
outside the allow-list, and missing per-action consent. The runtime companion
should call it before a remote file or repository action and record the user's
allow/deny decision through `/consent`.

## Independent verification and grounding

`/api/verifications` separates agent-reported completion from independently
reported test/build/static-analysis evidence. A verification request records the
commit, environment, and command; a runner starts and completes it with test,
coverage, and finding payloads. The resulting risk score is deterministic and
the findings remain queryable. `/grounding` records which source documents,
repository references, or semantic retrieval results influenced an agent run,
including outcome/feedback for future retrieval-quality analysis.

The API intentionally does not execute arbitrary commands in the WorkGraph
request process. A trusted runner or isolated execution service must claim a
verification request, run it in the target-matching environment, and call
`/:id/complete` with the signed result.

## Deployment

The bare-metal path applies the migration and regenerates the Prisma client.
Docker deployments should apply the same migration through the normal WorkGraph
migration step. Existing environments can apply the SQL idempotently. Run
focused checks with:

```bash
DATABASE_URL=... JWT_SECRET='at-least-32-characters' \
  pnpm --filter @workgraph/api build

DATABASE_URL=... JWT_SECRET='at-least-32-characters' \
  pnpm exec vitest run test/roadmap-gap-closure.test.ts
```

Signed/notarized desktop installers and external email/Slack/Teams provider
workers are deployment deliverables, not enabled by this migration. The data
contracts and fail-closed policy checks are now present so those adapters can be
added without changing workflow semantics.
