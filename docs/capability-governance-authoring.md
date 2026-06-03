# Capability Governance — Authoring UI + Stage-Attachment at Workflow Creation

Status: **G7a implemented** (this PR) · G7b / G7c / G8 planned.
Companion to [`capability-governance-model.md`](./capability-governance-model.md) (the G1–G6 model).

## Problem

Governance policies (the G1–G6 model) can be **created and read** via the IAM
API, but there is no way to **edit, deactivate, or list** them, and no UI to
manage them — the only surface is the read-only "Governed by" panel in the
workbench (G6). Two gaps:

1. **No authoring surface.** Policies are set by raw IAM API calls / direct DB
   inserts. No tab on the capability page; no edit/deactivate; no governing-
   capability picker.
2. **No way to attach governance to workbench node stages at workflow-creation
   time.** Authors want to say "this DEVELOP stage is governed by policy X"
   while building the loop — today governance only attaches to a *capability*.

## Central design tension (resolved)

A `governed_by` attachment is keyed on the **governed capability id**, but the
author wants to attach a policy to a **stage** at workflow-creation time — when
`WorkbenchDefinition.capabilityId` may still be null and the stage key may be
mid-edit.

**Resolution — option (b): persist intent on the stage, materialize via a
server-side reconciler.** Rejected alternatives: (a) blind POST-on-save →
duplicate attachments; (c) inline cap-ids in the loop JSON → no durable/
auditable home, couples loop JSON to IAM identity.

- Authoring writes **intent** onto `WorkbenchStage` (new nullable columns). No
  IAM rows are written at picker-change time.
- A reconciler materializes `scope=STAGE` IAM attachments **only when
  `capabilityId` + `stageKey` are both concrete**, on an **explicit definition
  save/promote** (never per-run, per-read, or inside a DB transaction), AFTER
  commit, **serialized per capability**.
- **Run-time binding uses `target_key = stageKey`, `target_kind = STAGE_KEY`**
  (NOT nodeId — nodeId is unstable: synthesized `blueprint-<key>` on one path,
  `loop.stage` on the other). The resolver already matches `scope=STAGE` when
  `target_key in (ctx.stageKey, ctx.nodeId)` and ranks STAGE highest.
- **Identity:** the reconciler normalizes to the IAM **business `capability_id`**
  before any GET/POST/PATCH (the resolver filters on it verbatim; using the UUID
  `id` would silently fail-open).
- **UNION, not override:** a stage attachment does not replace a capability-level
  `scope=ALL` attachment — contributions union and `effectiveMode = max(mode)`.
  A STAGE attachment **cannot make a stage less strict** than an `ALL=BLOCKING`
  default. The effective-overlay preview makes this visible (G8 acceptance).

## Locked decisions (D1–D5)

| # | Decision | Resolution |
|---|----------|------------|
| D1 | Per-stage contributions: authorable, or inherit the policy capability's? The resolver does **no** inheritance — an empty-contributions attachment is a no-op. | **Reconciler snapshots the governing capability's contributions into the attachment at materialize time** (add `governanceContributions` intent on the stage for overrides). Without this, MVP attachments bind nothing. |
| D2 | `is_governing` lifecycle when the last active attachment is deactivated. | **Compute `is_governing` as derived `EXISTS(active attachment)`** rather than a stored toggle (prevents reconciler thrash). Interim: the attach route still sets the flag true; never auto-toggles false. |
| D3 | Per-run overlay stability — re-resolve per dispatch, or pin? | **Pin the resolved overlay (`overlayHash` + `versionPins`) at run start.** Mid-run edits never change a running workflow's enforcement. Gate REQUIRED/BLOCKING edits behind an "affects N active runs" confirm. |
| D4 | `version` semantics. | **Monotonic counter, bumped on every mutation that changes a governance-relevant field — including deactivate/reactivate** (no bump on a no-op PATCH). |
| D5 | Pre-enforcement binding check. | **Confirm CF emits the loop stage `key` verbatim as `stage_key` on both governed paths, and the AgentTask node can carry `governedStageKey`, before enabling any enforcement.** |

## Phased plan

Independently shippable in order. **G7a is the hard gate — nothing else ships
until it lands.** G8 depends on G7a only.

### G7a — IAM mutate endpoints + authz + audit + unique index  ✅ (this PR)

Files: `singularity-iam-service/app/governance/{routes,schemas,authz}.py`,
`app/capabilities/routes.py`, `app/main.py`, `tests/test_governance_g7a.py`.

- **Endpoints:**
  - `PATCH /api/v1/capabilities/{id}/governed-by/{attachment_id}` — edit
    mode/scope/target/priority/effective_*/waiver_allowed/contributions; bumps
    `version` only when a governance-relevant field actually differs.
  - `POST .../governed-by/{attachment_id}/deactivate` + `/reactivate` — flip
    `is_active` (idempotent; bumps `version`).
  - `GET /api/v1/capabilities?is_governing=true` — governing-capability picker.
  - `GovernanceAttachmentOut.updated_at`; `UpdateGovernedByRequest`.
- **Authz** (`app/governance/authz.py`, pure/unit-tested): ADVISORY authoring =
  any authenticated user, or a service principal with `governance:author`.
  REQUIRED/BLOCKING (set/raise via POST or PATCH, and toggling an enforcing
  attachment) = super-admin **real user** or explicit `governance:enforce`
  scope. A service token's blanket M11 `is_super_admin` is **not** sufficient to
  enforce. (Finer-grained *per-capability* permission is a follow-up.)
- **Audit:** every attach/patch/deactivate/reactivate emits `record_event` (DB
  row, in-txn) + `emit_audit_event` (fire-and-forget to audit-gov) with actor,
  capability, attachment, before/after mode+scope+is_active, version;
  enforcing-mode changes are `severity=warning`.
- **Contributions validation:** enforcement-relevant shapes
  (`blockingControls[].controlKey`, `requiredEvidence[].evidenceKey`/`mode`,
  `approvalGates[].gateKey`, `toolPolicy` string lists) 422 instead of being
  silently dropped at run time.
- **Partial unique index** `uq_gov_attach_active (relationship_id, scope,
  COALESCE(target_key,'')) WHERE is_active` (via `_ADD_COLUMNS` raw-ALTER; IAM
  has no Alembic). Lets the G8 reconciler treat unique-violation as
  "converge → PATCH". POST attach catches it → `409`.
- **Resolver:** verified each contributed evidence/control keeps its **source
  attachment's own mode** (no bleed); regression test added.

### G7b — Read-only Governance tab  `[M, deps G7a]`

`UserAndCapabillity` · `CapabilityDetailPage`. Add `src/api/governance.api.ts`,
`src/types/governance.types.ts`, `src/hooks/useGovernance.ts`; a 4th
`TabsTrigger value="governance"` listing attachments (mode/scope/priority/
is_active/target badges). Hide `governed_by` from the Relationships Add dialog
(this tab is the source of truth) and cross-link.

### G7c — Authoring dialog  `[L, deps G7a, G7b]`

First edit-in-dialog flow on the page (controlled Selects so edits prefill).
Fields: governing capability (picker from `?is_governing=true`), mode (default
ADVISORY), scope + target, priority, waiver_allowed, contributions. Contributions
editor defaults to **inherited contributions read-only**, with raw-JSON behind
an "advanced" affordance + strict client validation. Wire
attach/patch/deactivate/reactivate; show `version`/`updated_at`.

### G8 — Per-stage governance in the designer + reconciler  `[XL, deps G7a]`

- **Data (`workgraph-studio`):** nullable `WorkbenchStage` cols
  `governancePolicyId`, **`governanceEnforcement`** (ADVISORY/REQUIRED/BLOCKING —
  renamed to avoid the existing node-level `governanceMode` fail-open field),
  `governancePriority`, `governanceContributions`. Thread through **both** the
  JSON `loopDefinition` contract (`LegacyStage` read + `writeThroughToLegacy`
  emit) **and** the table/Zod layer; round-trip + rename-survival tests.
- **UI (`apps/web` `NodeInspector`):** a "Policy enforcement" `<details>` block
  with a governing-capability picker (add `is_governing` to the studio
  `/lookup/capabilities` path), and a read-only **effective-overlay preview**
  (reuse `GovernancePanel`'s `resolveGovernance`) — capability-unset / pending /
  reconciler-failed states shown explicitly.
- **Reconciler (`apps/api/.../workflow/lib/reconcile-stage-governance.ts`):**
  on explicit save/promote, after commit, serialized per capability, normalized
  to business `capability_id`. Diff stage intent vs
  `GET governed-by?include_inactive=true` (scope=STAGE, target_kind=STAGE_KEY):
  POST/PATCH new/changed first, deactivate removed/renamed/cleared last (never
  hard-delete). Idempotency key `(capabilityId, STAGE, STAGE_KEY, stageKey)`;
  PATCH only on real diffs. Failures surface a designer banner (never swallowed).

## Rollout & safety

- **ADVISORY-first.** Pickers default ADVISORY; ADVISORY never fires the CF
  `GOVERNANCE_BLOCKED` gate.
- **Enforcement gated** behind `governance:enforce` authority (G7a) **and** a
  feature-flagged designer toggle, off initially.
- **Don't break live runs:** deactivate-not-delete + D3 run-start overlay
  pinning. A global "disable all BLOCKING" kill-switch on the resolve/CF path.
- **Audit** on every mutation; reconciler events tagged system/reconciler.
- **Idempotency/cleanup:** reconciler idempotent + serialized, backed by the
  mandatory partial unique index; orphaned STAGE_KEY rows GC'd.

## Required tests before enabling enforcement
JSON round-trip survival of governance fields; stage-rename survival;
concurrent-save duplicate prevention; non-blueprint AgentTask `stageKey` binding;
effectiveMode-bleed; capability_id identity smoke (author → resolve → overlay
contains it).
