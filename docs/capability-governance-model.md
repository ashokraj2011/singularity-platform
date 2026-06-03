# Capability Governance Model — Technical Specification & Implementation Plan (v2)

**Status:** Draft for implementation · **Scope:** Singularity platform (IAM, Workgraph, Context Fabric, Agent Runtime, mcp-server, Workbench)

> **Why v2:** This revises the original "Capability Governance Attachment Model" spec after a codebase-grounded review. The core change in stance: governance is a **capability playing a governing role via a `governed_by` relationship** (not a new parallel object), and the resolved overlay **compiles down into the machinery the governed loop already runs** (`StageExecutionPolicy`, prompt-composer layers, receipts, `stage_driver` stop-reasons, `ApprovalRequest`, audit-gov) — it does **not** introduce a second enforcement engine. Rollout is **ADVISORY-first**.

---

## 1. Purpose
Let any capability act as a **governing authority** (architecture board, security/compliance function, engineering-standards group) that attaches to operational capabilities and contributes policies, prompt guidance, required evidence, verifier agents, approval/waiver rules, and tool constraints — **resolved at runtime, snapshotted for audit, and compiled into existing governed-loop primitives**.

## 2. Design principles (non-negotiable)
1. **Governance is a role on the capability graph, not a new object.** A capability becomes governing by having `governed_by` edges into it + owning governance assets.
2. **Compile, don't enforce.** The resolver emits an overlay translated into `StageExecutionPolicy` + prompt-composer layers + receipt requirements + a `GOVERNANCE_BLOCKED` stop-reason + the existing `ApprovalRequest` gate. No second tool-check, no second approval system.
3. **Deterministic + snapshotted.** Same inputs + pinned asset versions ⇒ same `overlayHash`; every WorkItem/run/stage snapshots the resolved overlay.
4. **Fail-closed for blocking, advisory-first for rollout.** v1 ships ADVISORY-only; enforcement is later phases.
5. **Reuse over rebuild.** `CapabilityRelationship`, IAM membership/roles, capability-owned assets/agent-templates, receipts, audit-gov.

## 3. Governance as a capability role (core model)
Two **distinct relationship axes** on the capability graph — never conflated:

| Axis | Relationship type | Meaning | Cardinality |
|---|---|---|---|
| Composition | `parent_of` / `decomposes_to` (existing) | structural containment | tree-ish |
| **Governance** | **`governed_by` (new)** | cross-cutting authority/constraint | many-to-many, shared |

- A **governing entity** is an ordinary capability that (a) is the *target* of `governed_by` edges and (b) owns governance assets. It is **not** a new object model.
- `GOVERNING_ENTITY` is a **role marker** (`capability.is_governing = true`) used only for **filtering**: governing capabilities are **excluded from execution surfaces** (work routing, WorkItem targeting, delivery assignment, Epic→child dispatch) by **one guard at the routing boundary**.
- Reuse: `CapabilityRelationship` already carries `(source, target, relationship_type, inheritance_policy)` (IAM `models.py`). Governance attachment = a `governed_by` edge + a **governance-metadata side row** (§4).

## 4. Domain model
### 4.1 `governed_by` relationship (reuses `CapabilityRelationship`)
`source = governed operational capability`, `target = governing capability`, `relationship_type = 'governed_by'`, `inheritance_policy` reused.

### 4.2 GovernanceAttachment (metadata side-table, keyed by relationship id)
```jsonc
{
  "id": "gatt_123",
  "relationshipId": "crel_456",          // FK → capability_relationship (governed_by edge)
  "tenantId": "tenant_123",
  "mode": "ADVISORY",                     // ADVISORY | REQUIRED | BLOCKING
  "scope": "STAGE",                       // ALL | WORK_ITEM_TYPE | WORKFLOW_TYPE | WORKFLOW | STAGE
  "targetKind": "STAGE_KEY",              // typed companion to targetKey (see §19)
  "targetKey": "SECURITY_REVIEW",
  "priority": 100,
  "isActive": true,
  "effectiveFrom": "2026-06-01T00:00:00Z",
  "effectiveTo": null,
  "waiverAllowed": true,                  // honored only in REQUIRED/BLOCKING (v2+)
  "version": 1,
  "createdBy": "user_123", "createdAt": "…", "updatedAt": "…"
}
```
**Dropped from the original draft:** `conflictStrategy` (conflict order is global — §6.2); `inheritanceBehavior` (use the relationship's `inheritance_policy`).

## 5. Modes
- **ADVISORY** — inject guidance/prompt layers + optional evidence/verifiers; never blocks. *(v1 scope.)*
- **REQUIRED** — must be satisfied; missing ⇒ stage incomplete; promotion blocked unless a valid waiver exists. *(v2+.)*
- **BLOCKING** — prevents stage approval / promotion / release until satisfied; waiver only if policy permits. **Fail-closed**: resolution/validation error ⇒ blocked. *(v2+.)*

## 6. Scope & conflict resolution
### 6.1 Scopes
`ALL | WORK_ITEM_TYPE | WORKFLOW_TYPE | WORKFLOW | STAGE` (most-specific = STAGE).

### 6.2 One deterministic conflict order (total order)
When multiple attachments apply, resolve by strict precedence:
1. **Mode rank** — BLOCKING > REQUIRED > ADVISORY (a blocking control always wins, regardless of priority).
2. **Scope specificity** — STAGE > WORKFLOW > WORKFLOW_TYPE > WORK_ITEM_TYPE > ALL.
3. **Priority** — higher wins.
4. **Deterministic tiebreak** — attachment `id` ascending.

**Additive (never win/lose):** required evidence, prompt layers, verifier agents (deduped by `(agentTemplateId, trigger)`), blocked tools. **Tool precedence:** `blocked` > `approval_required` > `allowed`; unknown tool ⇒ inherit base policy. **Waivers evaluated last**, after blocking controls are resolved.

## 7. Governing-capability-owned assets (all reuse existing capability assets)
| Governance asset | Maps to existing primitive |
|---|---|
| Knowledge artifacts / checklists | capability knowledge artifacts → Context Fabric retrieval |
| Prompt layers | prompt-composer `StagePromptBinding` / layers |
| Verifier agents | capability-owned **agent templates** |
| Required-evidence definitions | the governed-loop **receipts** vocabulary (§13) |
| Approval / waiver rules | IAM **membership + roles** on the governing capability + existing `ApprovalRequest` |
| Tool policy | tool-gateway / `_CONTEXT_POLICY_CATEGORIES` |

## 8. Resolution → Compilation
Resolve at: **(a) WorkItem creation / workflow attachment**, and **(b) before each stage executes**.

**Inputs** (versioned for determinism):
```jsonc
{
  "tenantId": "tenant_123",
  "sourceCapabilityId": "cap_collection",
  "targetCapabilityId": "cap_rule_engine_delivery",
  "workItemType": "BUG_FIX", "workflowType": "SOFTWARE_DELIVERY",
  "workflowId": "wf_…", "stageKey": "DEVELOP", "agentRole": "DEVELOPER",
  "nodeId": "node_develop", "riskLevel": "MEDIUM",
  "policyVersionPins": { "gatt_123": 1, "promptLayer:SECURITY_CONTROLS": 4, "verifier:agent_sec": 7 }
}
```
**Traversal:** source capability → target capability → `governed_by` edges (honoring `inheritance_policy`) → filter by scope/effective-window/active → apply §6.2 order. **Cycle guard:** visited-set over `governed_by` edges (a governing capability may itself be governed); abort on revisit.

**Compilation — the overlay is translated into existing machinery:**
- `toolPolicy` → narrows the **tool-gateway** allow/block/approval sets (same path as `StageExecutionPolicy.tool_policy` / context-policy categories).
- `promptLayers` → assembled by the **prompt-composer ladder** (registered as governance layers, ordered per §11.3).
- `requiredEvidence` → **receipt requirements** checked by `stage_driver` promotion logic.
- `blockingControls` → `GOVERNANCE_BLOCKED` **stop-reason** in `stage_driver` (sibling of `NEEDS_CONTEXT` / `VALIDATION_BLOCKED` / `APPROVAL_PENDING`).
- `approvalGates` / waivers → existing **`ApprovalRequest`** human gate.

## 9. Resolved Governance Overlay (output)
Deterministic; `overlayHash = sha256(canonicalize(overlay_without_hash))`, **including resolved asset version pins**.
```jsonc
{
  "overlayId": "gov_overlay_123",
  "overlayHash": "sha256:…",
  "resolvedAt": "…", "tenantId": "tenant_123",
  "governedCapabilityId": "cap_rule_engine_delivery",
  "effectiveMode": "ADVISORY",                 // max mode in this overlay
  "governingEntities": [ { "capabilityId":"cap_security_compliance","name":"Security Compliance","mode":"BLOCKING","priority":200,"version":1 } ],
  "promptLayers":   [ { "layerKey":"SECURITY_CONTROLS","sourceCapabilityId":"cap_security_compliance","order":40,"version":4,"required":true } ],
  "requiredEvidence":[ { "evidenceKey":"UNIT_TEST_RESULTS","stageKey":"QA","mode":"REQUIRED","receiptType":"TEST_RUN","rule":{"status":"PASSED"} } ],
  "verifierAgents": [ { "agentTemplateId":"agent_security_reviewer","trigger":"BEFORE_STAGE_APPROVAL","blockingOnFailure":true,"version":7 } ],
  "toolPolicy":     { "blocked":["external_network_call","production_deploy"], "approvalRequired":["git_push"], "allowed":[] },
  "approvalGates":  [ { "gateKey":"SECURITY_APPROVAL","requiredRole":"SECURITY_LEAD","stageKey":"SECURITY_REVIEW" } ],
  "waiverRules":    [ { "controlKey":"SECURITY_REVIEW_RECEIPT","waiverAllowed":true,"allowedRoles":["SECURITY_LEAD"],"requiresReason":true } ],
  "blockingControls":[ ]                        // empty in ADVISORY v1
}
```

## 10. Snapshotting & inheritance
- Snapshot the **full resolved overlay JSON + hash** at: WorkItem creation, run start, and **before each stage**. Idempotency key `(work_item_id, workflow_node_id, overlay_hash)`.
- Runtime reads the **snapshot**, never live governance state (no history rewrite on policy change).
- **Child WorkItem runs (Epic→child fan-out):** the child resolves **its own** overlay for its capability, then **merges inherited-parent controls** per the parent edge's `inheritance_policy` using §6.2 (BLOCKING from either side wins; evidence/layers/verifiers union).

## 11. Context Fabric integration
### 11.1 Request — pass the **full overlay inline** (not just the hash; CF stays stateless about governance)
```jsonc
{ "trace_id":"…",
  "run_context": { "workflow_instance_id":"…","workflow_node_id":"node_develop","work_item_id":"…","capability_id":"cap_rule_engine_delivery","agent_template_id":"agent_developer" },
  "task":"Fix null handling in the array operator.",
  "governance_overlay": { /* the resolved overlay from §9 */ } }
```
### 11.2 CF responsibilities
Compile the overlay into the run: assemble governance prompt layers via the existing ladder, narrow the tool-gateway, add required-evidence instructions to the prompt, register verifier requirements, set governance mode, **emit audit events**, and **return governance status in the `/execute` response**.
### 11.3 Prompt layer order (governance before code context — matches the deployed ordering)
`PLATFORM_CONSTITUTION → AGENT_ROLE → GOV_ARCHITECTURE → GOV_SECURITY → GOV_ENGINEERING_STANDARDS → CODE_WORLD_MODEL → CODE_TASK_INTENT → CODE_EDITABLE_SLICES → TOOL_CONTRACT → TASK_CONTEXT`.

## 12. Enforcement points (v2+, all reuse existing halts)
- **Stage promotion** (`stage_driver`): evaluate required evidence (receipts) → required verifiers ran → blocking verifiers passed → no unresolved blocking controls → no tool-policy violations → valid waivers present. Failure ⇒ `stop_reason = GOVERNANCE_BLOCKED` (fail-closed).
- **Approvals/waivers:** existing `ApprovalRequest`; waiver approver = governing-capability member with the allowed role.
- **Tool policy:** enforced *only* in the tool-gateway.

## 13. Evidence ↔ receipts
`requiredEvidence.receiptType` must reference a **real governed-loop receipt** (e.g. `TEST_RUN`, `EDIT_RECEIPT`, `VERIFICATION_RECEIPT`, `CONTEXT_RECEIPT`). Validation = "a receipt of type X with status Y exists for stage Z". No new evidence store beyond `governance_evidence` linking receipt/artifact ids.

## 14. Verifier agents
Templates **owned by the governing capability**; instances run under the **governed capability's run-context** (tenancy/audit attribute to the governed run). Triggers: `AFTER_CODE_GENERATION | BEFORE_STAGE_APPROVAL | BEFORE_MERGE | BEFORE_RELEASE | ON_EVIDENCE_SUBMISSION`. Result carries `status`, `blockingFindings[]`, `recommendation`. (Execution is **v2+**; v1 may register/preview only.)

## 15. Workbench surfacing (v1 includes read-only display)
- **WorkItem / Stage:** "Governed by" (list), active controls, injected guidance, allowed/blocked tools, required evidence, verifier results, status `ADVISORY | REQUIRED | BLOCKED | WAIVED | PASSED`.
- **Blocked state (v2+):** reason + source governing capability + allowed actions (Submit evidence / Run verifier / Request waiver).
- **Capability detail → Governance tab:** attached governing capabilities + preview resolved overlay; **Governing-capability detail:** governed capabilities + assets + impact analysis.

## 16. API
- `POST /api/v1/capabilities/{id}/governed-by` — create a `governed_by` attachment (+metadata).
- `GET  /api/v1/capabilities/{id}/governed-by` — list (and reverse: `…/governs`).
- `POST /api/v1/governance/resolve` — **returns the full overlay** (§9), not just an id/hash.
- `POST /api/v1/work-items/{id}/governance-snapshot` — store the resolved overlay (caller-provided; avoids re-resolve drift).
- `POST /api/v1/work-items/{id}/evidence` — link a receipt/artifact to an `evidenceKey`.
- `POST /api/v1/work-items/{id}/governance-waivers` — request waiver (v2+; routes to `ApprovalRequest`).

## 17. Database (hygiene fixed)
```sql
-- role marker (capability_type column is free-string today; add a boolean for fast filtering)
ALTER TABLE capability ADD COLUMN is_governing BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE governance_attachment (
  id UUID PRIMARY KEY,
  relationship_id UUID NOT NULL REFERENCES capability_relationship(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  mode VARCHAR(16) NOT NULL CHECK (mode IN ('ADVISORY','REQUIRED','BLOCKING')),
  scope VARCHAR(32) NOT NULL CHECK (scope IN ('ALL','WORK_ITEM_TYPE','WORKFLOW_TYPE','WORKFLOW','STAGE')),
  target_kind VARCHAR(32),                 -- WORK_ITEM_TYPE | WORKFLOW_TYPE | WORKFLOW_ID | STAGE_KEY | NODE_ID
  target_key  VARCHAR(255),
  priority INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from TIMESTAMPTZ, effective_to TIMESTAMPTZ,
  waiver_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  version INT NOT NULL DEFAULT 1,
  created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_gatt_relationship ON governance_attachment(relationship_id);
CREATE INDEX idx_gatt_tenant_active ON governance_attachment(tenant_id, is_active);

CREATE TABLE governance_overlay_snapshot (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  work_item_id UUID, workflow_instance_id UUID, workflow_node_id VARCHAR(255),
  governed_capability_id UUID NOT NULL,
  overlay_hash VARCHAR(128) NOT NULL,
  resolved_overlay_json JSONB NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (work_item_id, workflow_node_id, overlay_hash)
);
CREATE INDEX idx_gov_snap_wi  ON governance_overlay_snapshot(work_item_id);
CREATE INDEX idx_gov_snap_run ON governance_overlay_snapshot(workflow_instance_id);

CREATE TABLE governance_evidence (
  id UUID PRIMARY KEY, tenant_id UUID NOT NULL,
  work_item_id UUID NOT NULL, workflow_instance_id UUID, workflow_node_id VARCHAR(255),
  evidence_key VARCHAR(255) NOT NULL, receipt_id UUID, artifact_id UUID,
  status VARCHAR(32) NOT NULL, submitted_by UUID, submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_gov_evidence_wi ON governance_evidence(work_item_id, evidence_key);

CREATE TABLE governance_waiver (    -- v2+
  id UUID PRIMARY KEY, tenant_id UUID NOT NULL,
  work_item_id UUID NOT NULL, workflow_instance_id UUID, workflow_node_id VARCHAR(255),
  control_key VARCHAR(255) NOT NULL, reason TEXT NOT NULL,
  status VARCHAR(32) NOT NULL, requested_by UUID, approved_by UUID,
  expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 18. Audit events (on the existing audit-gov bus — currently DOWN in the dev stack; Phase 3 must bring it up)
`governance.attachment.{created,updated,deactivated}`, `governance.overlay.{resolved,snapshotted}`, `governance.evidence.submitted`, `governance.verifier.{started,completed}`, `governance.stage.{blocked,approved}`, `governance.waiver.{requested,approved,rejected}`. Every event includes `traceId, tenantId, workItemId, workflowInstanceId, governedCapabilityId, governingCapabilityId, overlayHash`.

## 19. Vocabulary (pinned — prevents the M81-class id/role conflation)
`stage_key` (loop stage, e.g. `DEVELOP`), `agent_role` (e.g. `DEVELOPER`), `nodeId` (workflow node), `workflowId` (template), `workflowType`, `workItemType`. `targetKey` is **always paired with `targetKind`**; never a bare ambiguous "stageId".

## 20. Non-functional
Determinism (hash over canonicalized overlay incl. version pins); auditability (read snapshots, never live state); **fail-closed** for BLOCKING on resolver/validation error; cache resolved overlay by `(inputs, version-pins) → overlayHash`; tenancy threaded on every table/event; explainability (Workbench answers who governs / what applies / what's missing / why blocked / who can waive).

## 21. Phased rollout
- **Phase 0 — spike:** prove `overlay → StageExecutionPolicy + prompt layers` against current `turn.py` / `stage_driver`; lock relationship-vs-table (✅ relationship) + conflict order; decide `is_governing` marker + the routing-boundary guard.
- **Phase 1 — model + resolve + snapshot, ADVISORY-only** on a pilot capability (Rule Engine Delivery): `governed_by` + metadata, resolver, deterministic hash, snapshots, Governance tab.
- **Phase 2 — CF compilation:** inline overlay → prompt layers + (advisory) tool/evidence hints; governance status in `/execute`; Workbench "Governed by".
- **Phase 3 — audit:** bring audit-gov up; emit all events; replay verified.
- **Phase 4 — REQUIRED/BLOCKING enforcement:** `GOVERNANCE_BLOCKED` stop-reason, receipt-based evidence gates, promotion checks.
- **Phase 5 — verifier execution + waivers:** verifier agents run on triggers; waivers via `ApprovalRequest`.

## 22. Acceptance criteria
- A capability can be marked governing and **excluded from execution routing by a single guard**.
- `governed_by` attachments support mode/scope/targetKind+Key/priority/effective-window/active, many-to-many, resolved by WorkItem/workflow/stage context using **one documented total order**.
- Resolver is **deterministic** (stable hash for stable inputs+versions), outputs the §9 overlay, and is **snapshotted** at workitem/run/stage with the idempotency key.
- CF receives the **full overlay inline**, assembles governance prompt layers via the existing ladder, and returns governance status.
- (v2+) Blocking controls halt promotion via `GOVERNANCE_BLOCKED`; valid waivers unblock via `ApprovalRequest`; evidence maps to real receipts.
- Historical runs always show the governance that applied at execution time.

## 23. Open decisions to confirm before Phase 0
1. `is_governing` boolean vs `capability_type='GOVERNING_ENTITY'` — **recommend the boolean** (the type column is unconstrained today; overloading it complicates filtering).
2. Does parent-capability composition **also** imply inherited governance, or is governance **only** via explicit `governed_by` edges? — **recommend explicit-only** (composition ≠ governance).
3. Tenancy source: single `tenant_id` per capability vs per-attachment — decides whether `tenant_id` is derivable or stored.

---

## Appendix A — Critical files / integration points (current codebase)
- **IAM:** `singularity-iam-service/app/models.py` — `Capability` (`capability_type` free string; add `is_governing`), `CapabilityRelationship` (`source/target/relationship_type/inheritance_policy`; add `governed_by`). `app/capabilities/routes.py` — relationship CRUD + the `GET /capabilities/{id}/relationships` reused by the Epic discovery.
- **Workgraph API:** governance resolve/snapshot endpoints + the routing-boundary guard (exclude `is_governing` capabilities from WorkItem targeting / routing — see the work-items + work-item-routing services).
- **Context Fabric:** `services/context_api_service/app/governed/` — `policy_loader.py` (`StagePolicy`), `stage_execution_policy.py` (`StageExecutionPolicy`, `apply_execution_policy`, `_CONTEXT_POLICY_CATEGORIES`), `turn.py` (prompt assembly + tool descriptors + `/execute-governed-turn`), `stage_driver.py` (stop-reasons: add `GOVERNANCE_BLOCKED`), the receipts vocabulary, `ApprovalRequest` gate.
- **prompt-composer:** `StagePromptBinding` / layer ladder (register governance prompt layers).
- **mcp-server:** tool-gateway / tool dispatch (single tool-policy enforcement point).
- **audit-gov:** the event bus (currently not running in the dev stack).

## Appendix B — What this reuses vs. what is net-new
**Reuse:** capability object, IAM membership/roles (for approvers/waivers), `CapabilityRelationship` + `inheritance_policy`, capability-owned artifacts/agent-templates, prompt-composer layers, receipts (as evidence), `ApprovalRequest`, `stage_driver` halt/stop-reason pattern, snapshot pattern, audit-gov.
**Net-new:** `is_governing` marker + routing guard; `governed_by` relationship type; `governance_attachment` metadata + `governance_overlay_snapshot` / `governance_evidence` / `governance_waiver` tables; the resolver (`/governance/resolve`) + overlay→`StageExecutionPolicy`/layers compiler; the `GOVERNANCE_BLOCKED` stop-reason; Workbench governance surfaces.
