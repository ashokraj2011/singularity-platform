# Tenant RLS cutover — readiness audit (2026-07-01)

Companion to `rls-cutover-manual-apply-only.sql`. This is the evidence behind that
file's BLOCKERS section: a full inventory of every code path that still touches the
16 RLS-scoped tables **without** tenant scoping, and therefore what breaks the moment
`FORCE ROW LEVEL SECURITY` is applied.

## How to read this

A DB call is **scoped** iff it runs with `app.tenant_id` set — i.e. inside a
`withTenantDbTransaction(prisma, …)` callback (the `prisma` Proxy in `lib/prisma.ts`
routes to the open tenant transaction via AsyncLocalStorage, so even a bare
`prisma.X` call is scoped when it *executes inside* such a callback, directly or via a
helper). A bare `prisma.X` call that runs outside any such callback is **unscoped**:
under FORCE RLS its reads return empty and its writes are rejected by `WITH CHECK`.

The global `tenantDbContextMiddleware` only stores a tenantId in AsyncLocalStorage —
it does **not** open a transaction — so a handler that never calls
`withTenantDbTransaction` is unscoped no matter what.

## Bottom line

**Of the 16 tables, only 1 is safe to FORCE today: `workflow_run_budgets`.**
The other 15 each have at least one unscoped access path. ~115 unscoped call sites
across ~15 files remain.

The engine-side work (slices 1–5b, PRs #297–#303) is done and correct, but it only
ever covered the ENGINE's own writes. RLS applies to **every** access path, and the
**router/service layer** — the majority of access to these tables — is largely
unscoped (except the ~14 router files that were tenant-scoped before this initiative,
plus the specific lifecycle calls slice 1b/5b threaded). So the cutover is materially
further away than the initiative's "code-complete" status implied.

## Per-table verdict

| Table | Safe to FORCE now? | Unscoped access (where) |
|---|---|---|
| `workflow_run_budgets` | ✅ YES | none — only `budget.ts`/`cloneDesignToRun` (slice 3) + `insights.router` (scoped) |
| `workflow_instances` | ❌ NO | `instances.router` (~26), `blueprint.router` (~10), `work-items.service` (2), `work-item-routing.service` (2), `templates.router` (1), `triggers.router` webhook (1), `event-horizon.router` (1), `permissions/workflowTemplate.ts` assertInstancePermission (1), `learning/record-run-learning` (1), `planner.service` (1) |
| `workflow_nodes` | ❌ NO | `instances.router` (~15), `blueprint.router` (2), `work-items.service` (1), `WorkflowRuntime` attachment/deadline (1), `workbench-definitions.service` (2, see hazards) |
| `workflow_edges` | ❌ NO | `instances.router` (6) |
| `workflow_mutations` | ❌ NO | `instances.router` (6) |
| `workflow_events` | ❌ NO | `instances.router` (2) |
| `workflow_phases` | ❌ NO | `instances.router` (1) |
| `pending_executions` | ❌ NO | `instances.router` (4: poll/claim/complete) |
| `run_snapshots` | ❌ NO | `blueprint.router` (1) |
| `workflow_run_budget_events` | ❌ NO | `blueprint.router` (1) |
| `tasks` | ❌ NO | `tasks.router` (14 — all task CRUD) |
| `approval_requests` | ❌ NO | `work-items.service` (1), `event-horizon.router` (1) |
| `consumables` | ❌ NO | `instances.router` (5), `blueprint.router` (7), `work-items.service` (1), `event-horizon.router` (1) |
| `agent_runs` | ❌ NO | `agents.router` (3, incl. detached callbacks), `laptop.service` (2), `instances.router` (1) |
| `tool_runs` | ❌ NO | `WorkflowRuntime` attachment (1); + `ToolGatewayService` (6, caller-dependent — see hazards) |
| `documents` | ❌ NO | `tasks.router` (1 stray write); + `artifact-fetch.router` service-token read (see hazards) |

Fully-scoped surfaces (no work needed): `insights.router`, `TriggerScheduler`,
`agent-runs.router`, `tool-runs.router`, `tools.router`, `snapshots.router`,
`runtime.router`, `code-changes.router`, `receipts.router`, `consumables.router`,
`approvals.router`, `documents.router`, and the `assert*Tenant` helpers in
`tenant-isolation.ts`.

## Remaining work, by file (biggest first)

1. **`modules/workflow/instances.router.ts`** — ~60 sites. The run-graph editor +
   lifecycle + export API: node/edge/phase CRUD, params/globals, archive/restore,
   pending-execution poll/claim/complete, copilot export. The single largest surface.
2. **`modules/blueprint/blueprint.router.ts`** — 19 sites (session bind, artifact
   publish, several helpers). Includes bootstrap-read hazards (below).
3. **`modules/task/tasks.router.ts`** — 15 sites (all task CRUD + 1 stray document
   write). This router imports no tenant-tx machinery at all.
4. **`modules/work-items/work-items.service.ts`** — 5 sites.
5. **`modules/agent/agents.router.ts`** — 3 sites (incl. detached async callbacks).
6. **`modules/event-horizon/event-horizon.router.ts`** — 3 sites (platform snapshot counts).
7. **`modules/laptop/laptop.service.ts`** — 2 sites.
8. **`modules/work-items/work-item-routing.service.ts`** — 2 sites.
9. **`modules/workflow/workbench-definitions.service.ts`** — 2 sites (see hazards).
10. **`modules/workflow/runtime/WorkflowRuntime.ts`** — 2 sites (attachment/deadline
    subsystem — an engine gap slices 1–5b missed; being fixed separately).
11. **`lib/permissions/workflowTemplate.ts`** — 1 site (`assertInstancePermission`).
12. **`lib/learning/record-run-learning.ts`**, **`modules/planner/planner.service.ts`**,
    **`modules/internal/artifact-fetch.router.ts`**, **`modules/workflow/templates.router.ts`**,
    **`modules/workflow/triggers/triggers.router.ts`** — 1 site each.

## Structural hazards (not just "wrap N calls")

These need a decision on approach, not a mechanical wrap:

1. **Bootstrap-read chicken-and-egg.** Several places (e.g. `blueprint.router.ts:5467`,
   and the "bootstrap lookup" pattern slice 5b added in `blueprint.router` /
   `work-items.service`) do a *bare read of `workflow_instances` to obtain the
   tenantId*, then open a scoped tx with it. Under FORCE RLS that bootstrap read itself
   returns null (no GUC yet) — so the tenant resolution it performs is broken. These
   must source the tenantId from the **request/session** (or a bypass read path), not
   from the very row RLS is hiding. NOTE: this means some slice-5b "fixes" are
   structurally insufficient for the real cutover, even though they are inert today.
2. **Detached async callbacks.** `agents.router.ts` writes `agent_runs` inside a
   `llmProvider.complete().then()/.catch()` — the ALS/tx context is gone by the time
   those run. They need the tenantId captured up front and an explicit
   `withTenantDbTransaction(prisma, …, tenantId)`.
3. **Caller-dependent scoping.** `ToolGatewayService.requestToolRun/executeToolRun`
   are currently scoped only because *both* their callers happen to wrap them in a
   tenant tx. There is no local enforcement — a future caller outside a tx silently
   unscopes 6 `tool_runs` sites. Worth an assert.
4. **Permission guardrail.** `assertInstancePermission` reads `workflow_instances`
   unscoped; under FORCE RLS it denies access to *everything*. Permission checks that
   read RLS tables must be tenant-scoped (or use a bypass path).
5. **Service-token cross-tenant endpoints.** `artifact-fetch.router` (prompt-composer
   fetch) reads `documents` by id under a service token — likely *intended* to be
   cross-tenant. Needs a deliberate bypass strategy, not naive scoping.
6. **Nullable-instance standalone rows** (from the earlier review, still open): 6 of
   the 16 tables (`tasks`, `approval_requests`, `consumables`, `agent_runs`,
   `tool_runs`, `documents`) can hold rows with `instanceId IS NULL`, which the
   `workgraph_instance_visible("instanceId")` policy cannot represent. Those need a
   revised policy (e.g. a direct `tenantId` column) or elimination of standalone rows.

## Recommendation

Neither of the two options weighed before this audit survives it:

- **"Narrow the cutover to the engine-bound tables"** is effectively empty — only
  `workflow_run_budgets` is clean, and forcing RLS on one table provides no meaningful
  isolation.
- **"Finish the job"** is a substantial **Phase 2** initiative (~115 sites, ~15 files,
  + the 6 structural hazards), comparable in size to slices 1–5b combined.

Suggested Phase 2 shape: slice by file, biggest first (`instances.router` →
`blueprint.router` → `tasks.router` → `work-items`/`agents`/`laptop`/rest), with an
upfront decision on the hazards (esp. #1 bootstrap reads → source tenant from request;
#6 nullable-instance policy). The guarded `rls-cutover-manual-apply-only.sql` is the
correct end-state to apply only after Phase 2 lands and its guards pass.
