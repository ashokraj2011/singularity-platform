# Design — Program / Milestone Planner workflow

Status: **DRAFT for review** · Owner: (tbd) · Scope: workgraph-studio (work items + workflow engine), with an agent planning step via context-fabric/prompt-composer.

## 1. Problem & goal

We need a **Milestone (program) workflow**: from one high-level goal/epic, an agent **plans milestones**, and each milestone **becomes a Work Item — or a collection of Work Items — executed in sequence** (respecting dependencies). Each Work Item then runs through its own delivery workflow (e.g. *SDLC Delivery*), possibly in different capabilities/repos.

This is a **program-orchestration layer above the per-work-item SDLC**:

```
Epic/Program goal
   └─ Milestone Planner (agent) ──► ordered Milestones (a DAG)
        ├─ M1  → WorkItem(s)  ──► SDLC Delivery run(s)
        ├─ M2 (dependsOn M1) → WorkItem(s) ──► …
        └─ M3 (dependsOn M1) → WorkItem(s) ──► …   (M2,M3 parallel after M1)
```

### Not to be confused with the existing *in-loop* milestone mode
There is already a `milestonesMode` **inside the workbench loop** (`blueprint.router.ts` — `Milestone`, `MilestoneState`, `parseMilestonePlan`, `classifyMilestoneStages`). That decomposes **one** dev task and runs `develop→qa` **once per milestone on a single branch**, ending in one certification. It is *intra-run, single-capability, single-branch*.

This design is **inter-Work-Item**: milestones become **separate Work Items** (own lifecycle, own approval, own workflow run, possibly own repo/capability), sequenced by dependency. We **reuse the plan shape + topo-sort** from the in-loop code but operate at the Work Item layer. (Naming: call this **Program Plan** / **Program Milestones** to avoid collision with the in-loop term.)

## 2. Key decisions

1. **Milestones ARE Work Items** — no parallel "Milestone" table. We reuse the entire `WorkItem` lifecycle (routing, targets fan-out, approval, events, completion→advance). A milestone is a `WorkItem` with `workItemTypeKey = 'MILESTONE'`.
2. **The epic is a Work Item too** (`workItemTypeKey = 'EPIC'`), the parent of the milestones, holding the plan + aggregating completion.
3. **A milestone may be ONE unit or a COLLECTION** — reuse the existing `WorkItem.targets[]` fan-out (one milestone → N capability targets, parallel) and/or child Work Items for an intra-milestone sequence.
4. **The one genuinely new primitive: Work-Item→Work-Item dependencies.** Today sequencing is only parent↔child + graph edges; there is **no `dependsOn` between sibling Work Items**. We add it + a dependency-aware starter.
5. **Reuse the agent-plan machinery** — the planner is an `AGENT_TASK` that emits a `program_plan` artifact (validated/topo-sorted like `parseMilestonePlan`), not new agent infra.

## 3. Data model

### 3.1 New: Work-Item dependency (the core addition)
Add a join table (auditable, queryable; preferred over an embedded array):

```prisma
model WorkItemDependency {
  id           String   @id @default(uuid())
  workItemId   String   // the dependent (blocked) item
  dependsOnId  String   // the predecessor that must complete first
  kind         WorkItemDependencyKind @default(FINISH_TO_START)
  createdAt    DateTime @default(now())
  workItem     WorkItem @relation("widDependent",  fields: [workItemId],  references: [id], onDelete: Cascade)
  dependsOn    WorkItem @relation("widPredecessor", fields: [dependsOnId], references: [id], onDelete: Cascade)
  @@unique([workItemId, dependsOnId])
  @@index([dependsOnId])
}
enum WorkItemDependencyKind { FINISH_TO_START }  // room for START_TO_START etc. later
```

`WorkItem` gains two relations: `dependents WorkItemDependency[] @relation("widPredecessor")`, `dependencies WorkItemDependency[] @relation("widDependent")`. (v1 shortcut if we want zero-migration: store `dependsOn: string[]` in `WorkItem.details.dependsOn` — but the table is the right home for a DAG.)

### 3.2 Program / milestone identity (reuse existing fields)
- **Epic** = `WorkItem{ workItemTypeKey:'EPIC', input:{ goal, sourceType, sourceUri, … }, details:{ programPlanArtifactId } }`.
- **Milestone** = `WorkItem{ workItemTypeKey:'MILESTONE', parentCapabilityId, details:{ programId, milestoneId:'M2', acceptanceCriteria, estimate } }` + `WorkItemDependency` rows for `dependsOn`.
- Milestone start gating uses existing `status=SCHEDULED` + `routingState=UNROUTED` until its dependencies finish (see §5). `sourceWorkflowInstanceId/NodeId` link back to the planner run for advance-on-complete.

### 3.3 The plan artifact (reuse the in-loop schema, extended)
`program_plan` (JSON), validated + topo-sorted by a `parseProgramPlan()` modeled on `parseMilestonePlan` (`blueprint.router.ts:2889`):

```jsonc
{ "version": 1, "milestones": [
  { "id":"M1", "title":"Auth service skeleton", "subGoal":"…", "acceptanceCriteria":["…"],
    "dependsOn":[], "estimate":"3d",
    // NEW (program layer): how this milestone materializes
    "workItems":[ { "title":"…", "capabilityId":"…", "workflowTypeKey":"SDLC", "input":{…} } ],  // 1..N
    "parallelWithinMilestone": true } ,
  { "id":"M2", "dependsOn":["M1"], … }
]}
```
Validation (borrowed): unique ids, `dependsOn` references earlier ids only, **no cycles**, 1..N milestones; Kahn topo-sort returns the ordered DAG. If `workItems` omitted, default = one Work Item per milestone routed by capability default workflow.

## 4. The Planner workflow (graph)

A `profile=main` template — reuses existing node types; **one new node** (`MILESTONE_PLAN`) or an `AGENT_TASK`+convention.

```
START
  → AGENT_TASK "Plan program"            // emits program_plan artifact (validated, topo-sorted)
  → MILESTONE_MATERIALIZE                 // NEW node: plan → Epic + Milestone WorkItems + WorkItemDependency rows
  → SIGNAL_WAIT "all milestones done"     // or a WORK_ITEM-style fan-in gate
  → EVENT_EMIT "program.completed"        // (optional) emit to the bus / data sink
  → END
```

- **AGENT_TASK (Plan):** prompt the planner agent (a new `PROGRAM_PLANNER` role in prompt-composer) to decompose `{{goal}}` into the `program_plan`. Human gate (approve/edit the plan) before materialize — the plan is operator-editable, like the in-loop milestone_plan.
- **MILESTONE_MATERIALIZE (new executor):** read the approved `program_plan`; create the Epic WorkItem (if not already), then one Milestone WorkItem per plan entry (with its `workItems`/targets) + `WorkItemDependency` rows from `dependsOn`. Milestones with no unmet deps start immediately (AUTO_START); the rest sit `SCHEDULED`/blocked.
- **Fan-in gate:** the planner run advances to `END` when **all** milestone Work Items are `COMPLETED` (mirrors `handleWorkItemChildCompletion` → parent advance, `work-items.service.ts:1159/1262`).

> Alternative to a new node: `AGENT_TASK → FOREACH(plan.milestones) → WORK_ITEM`. `WORK_ITEM` already creates+routes items (`activateWorkItem`, `work-items.service.ts:259`). The reason to add `MILESTONE_MATERIALIZE` instead is that `FOREACH`+`WORK_ITEM` produces items in **parallel** with no inter-item `dependsOn` — and dependency wiring is exactly the new behavior. We can still reuse `createWorkItem`/`routeWorkItem` *inside* the new executor.

## 5. Sequencing & execution (the new runtime piece)

**Dependency-aware starter** — a small addition to `TriggerScheduler` (`triggers/TriggerScheduler.ts:37` already sweeps `SCHEDULED` items every 30s):

```
on each tick (and on every WorkItem completion event):
  for each MILESTONE WorkItem in status BLOCKED/SCHEDULED:
     if every WorkItemDependency.dependsOn is COMPLETED:
         routeWorkItem(id, { startNow:true })   // → spawns its workflow run(s)
         status → IN_PROGRESS
```

- **Event-driven (preferred) + sweep (safety net):** on `WorkItemCompleted` (outbox), immediately re-evaluate dependents of that item; the 30s sweep catches anything missed (same belt-and-suspenders the trigger scheduler already uses).
- **Within a milestone:** if `parallelWithinMilestone`, its constituent Work Items / targets run concurrently (existing fan-out); else chain them with intra-milestone `WorkItemDependency` rows.
- **Levels:** the DAG naturally runs each "ready set" in parallel; M2 & M3 (both dependsOn M1) start together once M1 completes.
- **A new status `BLOCKED`** (or reuse `SCHEDULED` with a `notBefore=null` + unmet-deps check) to represent "waiting on predecessors." Recommend adding `BLOCKED` to `WorkItemStatus` for clarity in the UI.

## 6. Lifecycle

```
Epic:      QUEUED → IN_PROGRESS (milestones running) → AWAITING_APPROVAL → COMPLETED
Milestone: BLOCKED (deps unmet) → SCHEDULED/QUEUED (ready) → IN_PROGRESS (workflow run) →
           [its targets SUBMITTED → AWAITING_PARENT_APPROVAL] → COMPLETED → unblocks dependents
```
Completion of a milestone fires the existing `handleWorkItemChildCompletion` → parent (Epic) aggregation; the Epic advances/closes when `allMilestonesComplete`.

## 7. UI

- **Plan step:** the workbench/portal shows the `program_plan` (milestones + dependsOn) as an **editable DAG** before materialize (operator can add/remove/re-order/re-point milestones).
- **Program board:** a DAG / swimlane view of milestone Work Items with status (BLOCKED/READY/RUNNING/DONE), each linking to its workflow run. Reuse the WorkItems board (`apps/web/.../WorkItemsPage`) + a dependency overlay.
- **EVENT_EMIT** (already built this session) can publish `program.milestone.completed` / `program.completed` to a sink/queue.

## 8. Reuse map

| Need | Reuse (file) | New? |
|---|---|---|
| Milestone = unit of work | `WorkItem` model (`schema.prisma:1047`) | — |
| Fan-out (collection of work) | `WorkItem.targets[]` + `activateWorkItem` (`work-items.service.ts:259`) | — |
| Create / route / start | `createWorkItem` (`:148`), `routeWorkItem` (`work-item-routing.service.ts:147`), `startInstance` | — |
| Run each milestone's workflow | routing policies → SDLC Delivery; `CALL_WORKFLOW` | — |
| Completion → advance | `handleWorkItemChildCompletion` (`:1159`), `approveWorkItem` (`:1262`) | — |
| Plan decompose + validate + topo-sort | `parseMilestonePlan` (`blueprint.router.ts:2889`) | adapt → `parseProgramPlan` |
| Periodic start | `TriggerScheduler` (`:37`) | extend: dependency-aware start |
| Emit program events | `EVENT_EMIT` node (this session) | — |
| **Inter-item dependency** | — | **`WorkItemDependency` + `BLOCKED` status** |
| **Materialize plan → items+deps** | `createWorkItem` inside | **`MILESTONE_MATERIALIZE` node** |
| Planner agent prompt | prompt-composer StagePromptBinding | **`PROGRAM_PLANNER` role/prompt** |

## 9. Open questions (need decisions before build)

1. **Dependency storage:** `WorkItemDependency` table (recommended) vs `details.dependsOn[]` array (zero-migration v1)?
2. **Epic as WorkItem vs WorkflowInstance:** model the program as an Epic *WorkItem* (recommended — reuses approval/aggregation) or as a long-lived *workflow instance* holding the plan?
3. **Milestone = N work items:** fan-out via `targets[]` (cross-capability, parallel) vs child Work Items (own approval each)? Both are possible; which is the default?
4. **Re-planning / drift:** if a milestone fails or scope changes mid-program, can the planner re-emit a plan and reconcile (add/cancel milestones)?
5. **Cross-repo / cross-capability:** milestones in different capabilities/repos — routing per milestone (policy by `capabilityId`)? (Supported by routing today.)
6. **Approval model:** auto-advance the DAG, or human gate per milestone (per the existing per-stage approval)?
7. **New status `BLOCKED`** vs overloading `SCHEDULED`.

## 10. Phased implementation

- **Phase 0 (this doc):** design sign-off + decisions in §9.
- **Phase 1 — dependencies:** `WorkItemDependency` (+ migration) + `BLOCKED` status + the dependency-aware starter in `TriggerScheduler` + completion-event re-evaluation. Unit-test the DAG starter (ready-set, cycles rejected, parallel levels).
- **Phase 2 — plan + materialize:** `parseProgramPlan` (adapt `parseMilestonePlan`), `PROGRAM_PLANNER` prompt, `MILESTONE_MATERIALIZE` executor + node type (enum + runtime + studio palette, same pattern as EVENT_EMIT this session).
- **Phase 3 — template + seed:** a "Program / Milestone Planner" `profile=main` workflow seeded (START→AGENT_TASK→MILESTONE_MATERIALIZE→fan-in→EVENT_EMIT→END) + routing (`epic`→planner).
- **Phase 4 — UI:** editable plan DAG + program board + dependency overlay.
- **Phase 5 — polish:** re-planning/reconcile, budgets per milestone (reuse the per-stage budget work), `EVENT_EMIT` program events to a sink.

## 11. Gaps & risks (found in self-review — design these before build)

### A. Blocking correctness (a happy-path-only build will deadlock or corrupt)
1. **Failure & deadlock.** The starter advances on predecessors `COMPLETED`, but says nothing about **failed/cancelled** predecessors → dependents stay `BLOCKED` forever. Need an explicit policy per dependency/program: `FAIL_FAST` (cancel-cascade dependents), `BLOCK_AND_ALERT` (default; hold + notify), or `SKIP_OPTIONAL` (milestone marked optional). Also undefined: **partial-collection done** — when a milestone fans out to N targets and some fail, is the milestone done/failed/partial?
2. **Resource contention — git collision (interacts with the new GIT_PUSH auto-push).** Two milestones that become ready together (both `dependsOn M1`) and target the **same repo** will run + **auto-push concurrently to the same branch** → push races / clobbered work. Must define isolation: **branch-per-milestone** (`prog/<epic>/<Mx>`) + an explicit **integration/merge milestone**, or a **per-repo serialization lock** so same-repo milestones can't run in parallel. Without this, parallelism + auto-push is unsafe.
3. **Concurrency / idempotency.** The dependency starter fires on both completion-events and the 30s sweep → **double-start race**; guard via a DB transition (e.g. `routingState UNROUTED→ROUTED` as a compare-and-set) so a milestone starts once. `MILESTONE_MATERIALIZE` must be **idempotent** (stable key `programId+milestoneId`) and transactional so a retry/restart mid-materialize doesn't duplicate milestones or dependency rows.
4. **`BLOCKED` state-machine integrity.** Adding `BLOCKED` to `WorkItemStatus` requires: defined valid transitions, and updating **every** consumer that switches on status (boards, counts, completion logic). Also: reject **dangling/cross-program** `dependsOnId` (predecessor deleted/cancelled, or outside this program) at materialize time.

### B. Operational
5. **Cancel / pause the whole program.** No cascade defined: cancelling an Epic must cancel **running** milestones (and their child workflow instances) **and** `BLOCKED` ones, with cleanup. Same for pause/resume.
6. **Program-level budget.** We have per-stage budgets, but a program spawns many runs (plus the planner's own LLM cost). Need an **aggregate USD/token cap across all milestones** (soft/hard), not just per-milestone — otherwise a big plan is an unbounded spend. Reuse the budget machinery at the Epic level.
7. **Cross-capability authority & approval routing.** Materialize creates Work Items in **other capabilities** — needs an authorization check (may the Epic's actor delegate there?) and **approval routing** (who signs off a milestone living in capability X — its owner, or the Epic owner?). The WORK_ITEM governance filter is partial coverage only.
8. **Re-planning / drift.** Listed as open Q4 but **not designed**: mid-flight scope change must add/cancel/re-point milestones **without orphaning running work** — needs a **versioned plan** + reconciliation (diff old→new plan, preserve completed/in-flight, only mutate untouched/blocked).
9. **Non-work-item gates.** `dependsOn` only covers sibling Work Items. Real programs also gate on **time** (reuse `notBefore`), **external events** (reuse `sourceEventTypeKey`), and **manual sign-off**. Fold these into the readiness check, not just predecessor completion.

### C. Quality / UX
10. **Status rollup & observability.** No design for program progress (% complete, **critical path**, ETA), nor "**why is M5 blocked / which dep**", nor milestone lifecycle **events** (started/blocked/failed/done) to `EVENT_EMIT`. Needed for the board to be usable and for external consumers.
11. **Plan quality, not just plan schema.** `parseProgramPlan` validates structure; it does **not** verify the milestones are right-sized, non-overlapping, and that their **union actually achieves the Epic goal**. Add a lightweight **plan critic** (a verify agent / completeness check) before materialize.
12. **Nested milestones.** A program milestone → *SDLC Delivery* → the **in-loop** milestone mode can nest. State explicitly that they **compose** (program layer vs intra-run layer) and guard against accidental double-decomposition / naming confusion.
13. **Testing depth.** Beyond DAG-starter unit tests: **failure-injection** (failed/cancelled predecessor, partial collection, cycle, dangling dep) and **end-to-end** (plan→materialize→sequenced execution→Epic close) integration tests.

> Net: the architecture is sound and reuse-heavy, but it is currently **happy-path**. Items **A1–A4** (failure/deadlock, git collision, double-start, BLOCKED integrity) are **must-fix before Phase 1 ships**; **B/C** can be staged but should be acknowledged up front so the schema/events leave room for them.

---
*Built on existing primitives — the only fundamentally new pieces are inter-Work-Item dependencies (+ dependency-aware start) and the materialize step; everything else reuses the proven WorkItem + routing + agent-plan machinery.*
