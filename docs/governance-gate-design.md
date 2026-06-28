# Design: Unified Governance Gate (Workflow Node)

> **Status:** Draft for review · **Date:** 2026-06-28 · **Scope:** Workgraph runtime + designer, IAM governance, MCP/Context-Fabric evidence, dual persistence (DB + git)

## Problem
SDLC and other governed workflows need a **first-class gate** that, at a point in the
graph, decides whether work may proceed based on *evidence* — design docs, standards,
code diffs, test/lint/formal receipts, evaluator results — and produces a structured,
auditable governance decision (pass / warn / block / request-approval).

Today there are three narrow nodes (`POLICY_CHECK`, `EVAL_GATE`, `VERIFIER`) and a
separate, richer **Capability Governance Model** that is enforced *inside* Context-Fabric
stage execution but is **not exposed as a placeable graph node**. We want one canonical
`GOVERNANCE_GATE` node whose *instructions are managed by a governing body via API*, and
whose evidence is **persisted in two places: the database and the work-item git branch.**

## Key finding — most of this already exists; the gate is a thin surface
The platform already has the **Capability Governance Model (G4/G7a/G8)**: IAM-resolved
governance overlays, `controlKey` controls, waivers, ADVISORY/REQUIRED/BLOCKING
enforcement, a tested evaluator, and overlay snapshots. It runs *inside* CF governed-stage
execution. **The Governance Gate exposes that model as a graph node** and adds an
evidence→control resolver + dual persistence. It is an **aggregator over existing engines,
not a new governance engine.**

| Capability | State | Where |
|---|---|---|
| Resolve governance instructions from API (governing body) | ✅ exists | `resolveGovernance(ctx)` → IAM `POST /governance/resolve` — `apps/api/src/lib/iam/client.ts:423` |
| Governing-body ≠ author RBAC | ✅ exists | IAM scopes `governance:author` (ADVISORY) / `governance:enforce` (REQUIRED·BLOCKING) — IAM `app/governance/authz.py` |
| Controls + block evaluation | ✅ exists (tested) | `controlKey`, `blockingControls`, `_evaluate_governance_block(overlay, satisfied, waived)` — `context-fabric/.../test_governance_gate.py` |
| Waivers (request→approve, node-scoped) | ✅ exists | `GovernanceWaiver` + `/governance/waivers*`, `activeWaiverControlKeys()` — `apps/api/src/modules/governance/governance.router.ts:121` |
| Applied-version audit | ✅ exists | `GovernanceOverlaySnapshot` (resolvedAt) |
| Node type + executor + dispatch | ✅ clean path | `schema.prisma` `enum NodeType`, `WorkflowRuntime.ts:511` `executeServerNode()`, `runtime/executors/` |
| Block/pause/audit/outbox pattern | ✅ house pattern | `EvalGateExecutor.ts` (block path), `lib/audit.ts` (`logEvent`/`publishOutbox`) |
| Approval routing (capability/role) | ✅ exists | `ApprovalRequest` (`schema.prisma:1356`), `ApprovalExecutor.ts` |
| Evidence: receipts / formal / evaluators / artifacts | ✅ exists | `/api/receipts`, `/api/v1/verification/verify`, `/api/v1/engine/evaluators/run-trace`, `/blueprint/...artifacts` |
| Evidence DB + object store | ✅ exists | Postgres + MinIO (`apps/api/src/lib/minio`) |
| Git write/commit to work-item branch | ✅ exists | `mcp-server/src/tools/fs-git.ts` (`writeFileTool`, `git_commit`), `copilot-execute.ts` |
| **GOVERNANCE_GATE graph node** | ❌ new | enum + executor + dispatch + designer |
| **Evidence → controlKey resolver** | ❌ new (the one real contract) | — |
| **Evidence committed to the git branch (dual write)** | ❌ new | `.singularity/evidence/…` + manifest |
| **`DIFF_VS_DESIGN` / `diffValidation`** | ❌ new control type | — |

## Goals / Non-goals
**Goals:** one canonical gate node; governing-body-managed instructions via API; reuse the
G4 model + existing evidence engines; normalized auditable decision; evidence + artifacts
durably present in **both DB and the git branch**; backward-compatible with the existing
narrow nodes.

**Non-goals (v1):** a new policy/solver engine; replacing in-stage CF governance (the gate
is *complementary* — it guards graph transitions; in-stage enforcement still guards a single
agent loop); LLM-assisted standards review (later check engine); migrating the existing
gate nodes away (kept as presets).

## Architecture
The gate is a SERVER executor that **resolves → satisfies → evaluates → decides**, reusing
G4 + existing evidence sources, and emits a normalized result.

```
GOVERNANCE_GATE executor (workgraph-api)
  1. RESOLVE   resolveGovernance(ctx)            ─▶ IAM overlay {controls, mode, waiverRules}   (+ snapshot)
  2. SATISFY   evidence → satisfied controlKeys  ─▶ /api/receipts · evaluators · formal · artifacts · diff
  3. WAIVE     activeWaiverControlKeys(workItem) ─▶ GovernanceWaiver (APPROVED, unexpired, node-scoped)
  4. EVALUATE  _evaluate_governance_block(overlay, satisfied, waived) ─▶ remaining blocking controls
  5. DECIDE    per-control mode + result         ─▶ PASSED | WARNED | BLOCKED | APPROVAL_REQUESTED
  6. EMIT      governance.gate.*  +  governanceGate output (overlay snapshot id, per-control status)
```

Decision → node lifecycle (reuses existing statuses + the waiver/approval mechanism):

| Result | Mode | Lifecycle |
|---|---|---|
| no blocking controls | any | **PASSED** → `advance()` |
| blocking | ADVISORY | **WARNED** → record findings, `advance()` |
| blocking | REQUIRED·BLOCKING, waiver allowed | **APPROVAL_REQUESTED** → create `GovernanceWaiver(REQUESTED)` + `ApprovalRequest` routed to the governing capability; on approve → waiver `APPROVED` → re-evaluate → advance |
| blocking | REQUIRED·BLOCKING, no waiver | **BLOCKED** → node `BLOCKED`, instance `PAUSED`, `_blockedByGovernanceGate` in context |

Follows the house block/advance pattern: atomic node+instance update, `WorkflowMutation`,
`logEvent`, `publishOutbox` (→ outbox + canonical event-bus + audit-gov ledger). Output is
merged to context top-level as `governanceGate` (consistent with `EVAL_GATE`/`VERIFIER`),
**not** a new `_governanceGateResults` map, so the cockpit's `BlockReasonBody`
(`RunGraphView.tsx`) renders it with minimal change.

## The one real new contract: control → evidence binding
How a `controlKey` is judged **satisfied** from run evidence:

| controlKey (example) | Satisfied when | Engine reused |
|---|---|---|
| `UNIT_TEST` | passing test receipt present for the run | `/api/receipts?trace_id=` |
| `SEC_REVIEW` | evaluator passes / approval recorded | `/api/v1/engine/evaluators/run-trace`, `ApprovalRequest` |
| `REL_NOTES` | `release_notes` artifact present | `/blueprint/...artifacts` |
| `FORMAL` | verify result SATISFIED / SAFE | `/api/v1/verification/verify` |
| `DIFF_VS_DESIGN` | captured code-change receipt matches design `diffValidation` (forbidden paths, tests, contract) | `/mcp/resources/code-changes` + design artifact (**new** `diffValidation`) |
| `EVIDENCE_PACK_COMPLETE` / `EVIDENCE_DB_GIT_CONSISTENT` | in-branch evidence pack complete + every manifest hash matches DB | dual-persistence manifest (below) |

- **v1:** built-in binding map for standard controlKeys, held in node/seed config.
- **v2:** move the binding *into the IAM overlay* so the governing body owns *which*
  controls **and** *how* they are evidenced — the full realization of "instructions from API."

`missingEvidencePolicy` (BLOCK·WARN·IGNORE) covers *absent* evidence; distinguish it from
*source-unreachable* (timeout/down) → its own finding, fail-closed for BLOCKING gates.

## Externalized governance instructions (governing body via API)
The node holds a **reference**, not inline rules: `{ governingCapabilityId | governed-by
attachment, scope, enforcement, optional local *tightening only* }`. At run time the
executor calls `resolveGovernance(ctx)` (IAM) to fetch the live overlay and **snapshots**
it (`GovernanceOverlaySnapshot`) so the audit shows exactly which controls/version were
enforced. RBAC is already enforced by IAM (`governance:author`/`governance:enforce`); the
governing body edits controls/standards/waiver-rules via that API, workflow authors only
reference them. **Fail-closed** if the governance API is unreachable on a BLOCKING gate.

## Dual persistence — evidence + artifacts in DB **and** the git branch
**Model: one source of truth, one derived mirror.**
- **DB (+MinIO) = operational source of truth** — drives cockpit, queries, tenant isolation.
- **Git branch = derived, durable, tamper-evident mirror** — travels with the code, survives
  the platform, auditable via signed git history.
- **Linked by content hash:** the DB row stores `{gitPath, commitSha, sha256}`; the git blob
  is the content; large blobs stay in MinIO with git holding a **pointer + hash** (git-LFS
  philosophy, no LFS). Mirrors the formal verifier's existing signed-hash receipts.

In-branch layout under the established `.singularity/` convention:
```
.singularity/evidence/<workItem>/<stageOrNode>/
  artifacts/  design_document.md, test_report.md, …
  receipts/*.json     governance/decision.json, waivers.json     formal/*.json
  manifest.json       # index: item → sha256 + dbId + minioRef
```

**Completeness is a governance control, not a side effect:** controlKeys
`EVIDENCE_PACK_COMPLETE` and `EVIDENCE_DB_GIT_CONSISTENT`. The "Evidence Pack Gate" preset
verifies the branch holds the full pack **and** every manifest hash matches the DB before
allowing `GIT_PUSH`. A DB↔git mismatch on either side is caught = tamper-evidence.

**Materialize incrementally, per stage** — each producing stage writes to DB **and** commits
its evidence to the local work-item branch *while its sandbox is live* (reusing
`fs-git.writeFileTool` + `git_commit`). The gate then only *reads/verifies* the branch, so
no live sandbox is needed at gate time (this also resolves `DIFF_VS_DESIGN`'s sandbox-
lifecycle dependency). **Ordering:** stages produce (DB + commit) → Governance Gate verifies
pack + consistency + controls → `GIT_PUSH` publishes a branch already carrying the evidence.

**Watch-outs:** redact secrets from evidence; per-tenant branch isolation; large blobs →
MinIO pointer (don't bloat the branch); partial-failure → gate fails closed.

## SDLC placement
The main SDLC graph is `START → CALL_WORKFLOW(loop) → GIT_PUSH → END`, with the 6 stages
*inside one* `WORKBENCH_TASK` and governance via per-stage policies — there are **no
explicit gate nodes** in the graph today. Place the Governance Gate **after the
`WORKBENCH_TASK`, before `GIT_PUSH`** (fits today's topology; low risk). Decomposing the
stage loop into per-stage graph nodes is a separate, larger change and not required.

## Designer + cockpit (declarative, low effort)
- Palette card: add to `NODE_GROUPS` ("Reliability/Governance") + `NODE_VISUAL`/`NODE_LABELS`
  (`WorkflowStudioPage.tsx`).
- Inspector: add `NODE_META.GOVERNANCE_GATE` with `standardFields` (`NodeInspector.tsx`) —
  governing capability ref, scope, enforcement, missing-evidence policy.
- Presets: Design Review · Diff vs Design · Standards Compliance · Release Readiness ·
  Security Gate · **Evidence Pack Gate** — config over the *same* executor.
- Cockpit: extend `BlockReasonBody` (`RunGraphView.tsx`) to render governance findings
  (per-control satisfied/waived/blocked, evidence refs, emitted events, waiver state).

## Phasing
- **v1** — `GOVERNANCE_GATE` node (enum migration + executor + dispatch) binding to G4
  (`resolveGovernance` + `_evaluate_governance_block` + waivers); built-in control→evidence
  map for `UNIT_TEST`/`SEC_REVIEW`/`REL_NOTES`/`FORMAL` + `REQUIRED_EVIDENCE`; HARD_BLOCK +
  ADVISORY modes; designer card + cockpit; SDLC seed places the gate before `GIT_PUSH`.
- **v2** — dual persistence (in-branch evidence pack + manifest + `EVIDENCE_PACK_COMPLETE`/
  `EVIDENCE_DB_GIT_CONSISTENT` controls); `DIFF_VS_DESIGN` + `diffValidation`; AUTOMATIC mode
  + approval/waiver route via `ApprovalRequest`.
- **v3** — move control→evidence bindings + standards into the IAM overlay (governing body
  owns which + how); LLM-assisted `STANDARD_CONFORMANCE`; `CUSTOM_EXPRESSION` via sandboxed
  `RUN_PYTHON`.

## Decisions (resolved for v1 — defaults; adjust if needed)
1. **Control→evidence binding** — built-in map in v1; migrate into the IAM overlay in v3.
2. **Evidence materialization** — incremental per-stage (each stage writes DB + commits in-branch while its sandbox is live); the gate only reads/verifies.
3. **Blobs** — in-tree text/JSON; large blobs in MinIO with an in-branch pointer + hash.
4. **Source of truth** — DB(+MinIO) authoritative; the git branch is the derived mirror.
5. **Severity model** — per-control mode (ADVISORY/REQUIRED/BLOCKING); no global `severityThreshold`.

## v1 Implementation plan (file-by-file)
Reuses existing patterns; the only genuinely new logic is the evidence→control resolver.
1. **Enum + migration** — add `GOVERNANCE_GATE` to `enum NodeType` (`apps/api/prisma/schema.prisma`) + migration `ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'GOVERNANCE_GATE'`; add to the `NodeType` union (`packages/shared-types/src/workflow.types.ts`).
2. **Evaluator port** — port the tested `_evaluate_governance_block(overlay, satisfied, waived)` to TS as a shared helper (mirror `context-fabric/.../test_governance_gate.py` cases) so the gate's core decision needs no cross-service call.
3. **Evidence→control resolver** (new) — `resolveSatisfiedControls(instance, bindingMap)` returning the satisfied `controlKey` set, calling existing clients: receipts (`/api/receipts`), evaluators (`/api/v1/engine/evaluators/run-trace`), formal (`/api/v1/verification/verify`), artifacts (`/blueprint/...`). Built-in bindings: `UNIT_TEST`,`SEC_REVIEW`,`REL_NOTES`,`FORMAL`,`REQUIRED_EVIDENCE`.
4. **Executor** — `runtime/executors/GovernanceGateExecutor.ts` `activateGovernanceGate(node, instance, actorId)`: resolve overlay (`resolveGovernance` + snapshot) → satisfied (step 3) → waived (`activeWaiverControlKeys`) → evaluate (step 2) → decide per mode. Block path mirrors `EvalGateExecutor.ts` (`BLOCKED`+`PAUSED`+`_blockedByGovernanceGate`+`WorkflowMutation 'GOVERNANCE_GATE_BLOCKED'`+`logEvent`+`publishOutbox`). Output `{ governanceGate: { status, mode, controls[], findings[], evidenceRefs[], overlaySnapshotId, eventsEmitted[] } }`.
5. **Dispatch** — import + `case 'GOVERNANCE_GATE'` in `executeServerNode()` (`WorkflowRuntime.ts:511`); on `passed` call `advance()`; add `_blockedByGovernanceGate` to `clearBlockedContext()` known keys.
6. **Designer** — palette (`WorkflowStudioPage.tsx` `NODE_GROUPS`/`NODE_VISUAL`/`NODE_LABELS`) + inspector (`NodeInspector.tsx` `NODE_META.GOVERNANCE_GATE.standardFields`: governing capability ref, scope, enforcement, missing-evidence policy) + presets (Design Review / Security Gate / Release Readiness / Evidence Pack Gate) + cockpit case (`RunGraphView.tsx` `BlockReasonBody`).
7. **Seed** — add the gate node after `WORKBENCH_TASK` / before `GIT_PUSH` in `seed-sdlc-main.ts` (`upsertNode`/`upsertEdge`).
8. **Tests** — executor unit tests (pass/warn/block/approval), evaluator-port parity vs the CF cases, designer create/save/run.

(v2 adds dual-persistence materialization + `EVIDENCE_PACK_*` controls + `DIFF_VS_DESIGN`/`diffValidation` + AUTOMATIC/approval route; v3 moves bindings into the overlay.)

## Test plan
- Gate **PASSES** with valid design artifact, matching captured diff, passing tests, safe formal result.
- HARD gate **BLOCKS** on missing design artifact, forbidden changed path, missing tests, failed evaluator, unsafe formal result, or governance-API unreachable (fail-closed).
- SOFT/ADVISORY records the same findings but advances.
- AUTOMATIC emits an approval/waiver request when a recoverable control is unsatisfied; on waiver `APPROVED`, re-evaluates and advances.
- Dual persistence: every evidence item exists in DB **and** in `.singularity/evidence/...`; `EVIDENCE_DB_GIT_CONSISTENT` fails on a hash mismatch; large blob stored in MinIO with an in-branch pointer.
- `governance.gate.*` outbox events fire for pass/warn/block/approval.
- Existing `POLICY_CHECK`/`EVAL_GATE`/`VERIFIER`/`GIT_PUSH`/`EVENT_EMIT` behavior unchanged.
- Designer can create/save/reload/run the node; cockpit shows findings + evidence + waivers.

## Risks / watch-outs
- **Cross-service fan-out latency** (formal=Z3 blocking, evaluators=LLM): per-source timeouts; consider running long checks as a non-SERVER node (`PendingExecution`) so the gate doesn't stall the runtime tick.
- **Enum migration** is irreversible — use `ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'GOVERNANCE_GATE'` (cf. the VERIFIER migration).
- **Delegation refactor:** to truly reuse `EVAL_GATE`/`VERIFIER` logic, extract a pure "evaluate→findings" core from those executors (they currently couple eval + block).
- **Evidence redaction / tenant isolation** for in-branch evidence.
