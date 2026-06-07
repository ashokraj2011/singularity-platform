# Design — "Planner" menu (describe → agent breaks down → work items in inboxes)

Status: **DRAFT for review** · Scope: workgraph-studio (`apps/web` + `apps/api`) + context-fabric (existing single-turn endpoint, no change). Sibling of, and on-ramp to, `program-milestone-planner-design.md` (this is the **flat-decomposition** v1; the DAG/sequencing is the program design's job).

## 1. What we're building

A new **Planner** menu. The user types a free-text description of *what they want*. An agent (via **context-fabric**) decomposes it into multiple **work items**. Each work item may be assigned to the current capability **or a child capability**. On confirm, the items are created and **appear in the owning capability's inbox**.

```
Planner page
  ┌────────────────────────────────────────────────┐
  │ Describe what you want …                         │  (textarea)
  │ Scope: [Payments ▼]   ☑ allow child capabilities │
  │                                   [ Break down ► ]│
  └────────────────────────────────────────────────┘
        │  POST /api/planner/breakdown   (preview only — nothing created)
        ▼
  Proposed work items (editable):
   #  Title                     Capability        Pri  ✎ ✕
   1  Design login screens      Payments (self)    1
   2  Auth backend endpoints    → Identity (child) 1
   3  Rate-limit middleware     → Platform (child) 2
        │  edit titles / re-assign capability / add / remove
        ▼  [ Create 3 work items ]  →  POST /api/planner/commit
  ✓ Created 3 work items → they appear in each capability's Inbox (/runtime)
```

Two-step **preview → commit** so the user reviews/edits before anything is created (safer + matches how the breakdown can be wrong).

## 2. The whole thing already has a path — almost no new infra

| Need | Reuse (exact) | New? |
|---|---|---|
| Agent decomposition (one shot) | `contextFabricClient.executeGovernedTurn()` → CF `POST /api/v1/execute-governed-single-turn` (`apps/api/src/lib/context-fabric/client.ts:436`; same call EventHorizon chat uses, `event-horizon.router.ts:164`) | — |
| List child capabilities | `listCapabilityRelationships(capId)` filter `relationship_type='decomposes_to'` + `isCapabilityGoverning` guard (`src/lib/iam/client.ts:231`, the WORK_ITEM `discoverChildren` pattern, `work-items.service.ts:283`) | — |
| Create a work item in a (child) capability's inbox | `createWorkItem({ targets:[{ targetCapabilityId }], … })` — **`WorkItemTarget.targetCapabilityId` is what the inbox filters on** (`work-items.service.ts:148`, list `work-items.router.ts:175`) | — |
| Inbox shows it | `/runtime` → `InboxPage` (`apps/web/src/features/runtime/InboxPage.tsx`); GET `/runtime/inbox`, auto-refetch 15s | — |
| Menu + page + route | `AppLayout.tsx` navItems (`:14`), `App.tsx` routes (`:66`), axios `api` (`lib/api.ts`), active capability (`store/activeContext.store.ts`) | new page only |
| **Planner endpoints** | — | **`POST /api/planner/breakdown`, `POST /api/planner/commit`** |
| **Planner prompt** | prompt-composer (a `PLANNER` profile) or an inline system prompt | **new prompt** |
| **(optional) audit/history** | — | **`PlannerSession` table** |

So: **two backend endpoints + one frontend page + one prompt.** Everything else is wiring of proven calls.

## 3. Backend

### 3.1 `POST /api/planner/breakdown` — preview (creates nothing)
**Request**
```jsonc
{ "description": "Build passwordless email login with rate limiting",
  "capabilityId": "<active capability>",      // the planner's home capability
  "allowChildren": true,                       // include child capabilities as assignment targets
  "maxItems": 12 }
```
**Flow**
1. Resolve the **assignable capability set** = self + (if `allowChildren`) `listCapabilityRelationships(capabilityId)` filtered to `decomposes_to` and **not governing**. Build `[{ id, name, description }]`.
2. Call `executeGovernedTurn({ trace_id:`planner:…`, run_context:{capability_id,user_id}, system_prompt: PLANNER_PROMPT, task: <description + the assignable-capability list>, model_overrides, limits:{ outputTokenBudget: 2500 } })`.
3. Parse `result.finalResponse` as JSON; **validate with zod** (see §3.3). **Re-ask once** on parse/validation failure (append the validation error to the task). On second failure, return the raw text + a 422 so the UI can show it.
4. **Server-side guard:** drop/repair any `capabilityId` the agent invented that isn't in the assignable set → fall back to `self`. (Never trust the model's capability id.)

**Response**
```jsonc
{ "sessionId": "ps_…",                         // if PlannerSession persisted (else omit)
  "items": [ { "title":"…", "description":"…",
              "capabilityId":"<id from the allowed set>", "capabilityName":"Identity",
              "isDelegation": true, "priority": 1, "urgency":"NORMAL",
              "estimate":"2d", "rationale":"…" } ],
  "usage": { "inputTokens":…, "outputTokens":…, "estimatedCostUsd":… },
  "assignableCapabilities": [ { "id":"…","name":"…" } ] }   // so the UI can offer re-assignment
```

### 3.2 `POST /api/planner/commit` — create the (possibly edited) items
**Request** = the edited `items[]` (+ `sessionId`, `capabilityId`). The client may have re-titled / re-assigned / pruned.
**Flow** — loop `createWorkItem` (no batch endpoint exists; `Promise.allSettled` so one failure doesn't sink the rest):
```ts
for (const it of items) {
  const isChild = it.capabilityId !== plannerCapabilityId
  createWorkItem({
    title: it.title, description: it.description,
    parentCapabilityId: plannerCapabilityId,          // provenance (NOT inbox ownership)
    originType: isChild ? 'PARENT_DELEGATED' : 'CAPABILITY_LOCAL',
    routingMode: 'MANUAL',                              // lands QUEUED in the inbox; owner claims/routes
    urgency: it.urgency, priority: it.priority,
    details: { source: 'planner', plannerSessionId, rationale: it.rationale },
    targets: [{ targetCapabilityId: it.capabilityId }], // ← this is what puts it in that inbox
  }, userId)
}
```
**Response** `{ created:[{id,workCode,capabilityId}], failed:[{title,error}] }`.
**Idempotency:** dedupe per `plannerSessionId` (a committed session can't double-create on a double-click); the UI also disables the button after first submit.

### 3.3 Structured-output contract (zod, server-validated)
```ts
const PlannerItem = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(8).max(4000),
  capabilityId: z.string(),                    // MUST be ∈ assignable set (server re-checks)
  priority: z.number().int().min(0).max(100).default(50),
  urgency: z.enum(['LOW','NORMAL','HIGH','CRITICAL']).default('NORMAL'),
  estimate: z.string().max(80).optional(),
  rationale: z.string().max(600).optional(),
})
const PlannerPlan = z.object({ version: z.literal(1).optional(),
  items: z.array(PlannerItem).min(1).max(20) })
```

### 3.4 Planner prompt (sketch — lives in prompt-composer as a `PLANNER` profile)
> You decompose a goal into concrete, **independently actionable** work items. You are given the goal and a list of capabilities (id, name, scope). For each work item: a clear title + a 2–5 sentence description (acceptance-oriented), and assign it to the **single most appropriate capability from the provided list** by `id` — never invent an id; if unsure, use the home capability. Keep items non-overlapping and right-sized (½–3 days). Output **strict JSON** matching the schema; no prose. Max {{maxItems}} items.

## 4. Frontend (`apps/web`)

1. **Nav** — `AppLayout.tsx:14` navItems → add `{ to:'/planner', label:'Planner', icon: Sparkles }` (above Inbox).
2. **Route** — `App.tsx:66` → `<Route path="planner" element={<PlannerPage/>} />`.
3. **`features/planner/PlannerPage.tsx`** (new):
   - `const active = useActiveContextStore(s=>s.active)` → `capabilityId`.
   - **Step 1 (describe):** textarea + `allowChildren` toggle + maxItems → `breakdownMut = useMutation(() => api.post('/planner/breakdown', {...}))`. Show a thinking state + token/cost from `usage`.
   - **Step 2 (review):** editable table of `items` — inline edit title/description/priority; a **`CapabilityPicker`** per row seeded from `assignableCapabilities` (reuse `components/lookup/EntityPickers.tsx:60`); add-row / delete-row; a "delegated → child" badge.
   - **Step 3 (commit):** `commitMut = useMutation(() => api.post('/planner/commit', { sessionId, items }))` → on success, toast "Created N (M delegated to children)" and `navigate('/runtime')` (the Inbox) — items appear there on its 15s refetch.
4. **api client** — just `api.post(...)`; no new infra (`lib/api.ts`).

## 5. Child-capability behavior (the "might belong to child" part)

- A work item assigned to a child is created with `targets:[{ targetCapabilityId: child }]` + `originType:'PARENT_DELEGATED'` + `parentCapabilityId:` the planner's capability.
- **It appears in the child capability's Inbox** because the inbox query filters `targets.some.targetCapabilityId` (`work-items.router.ts:175`). The child claims/routes it like any other work item; this rides the **existing delegation model** (parent provenance, child execution, optional parent approval on completion).
- **Governance guard:** governing capabilities are excluded from the assignable set (reuse `isCapabilityGoverning`), same as WORK_ITEM node behavior.

## 6. Persistence (optional for v1, recommended)
`PlannerSession { id, capabilityId, createdById, description, proposal Json, status: DRAFT|COMMITTED, createdWorkItemIds String[], usage Json, createdAt }`. Gives: audit, "Planner history", refresh-survival of a proposal, and the idempotency key for commit. v1 can be **stateless** (proposal held in the client) and add this later — but it's cheap and worth it.

## 7. How this relates to the Program/Milestone design
This Planner is the **intake + flat breakdown** front-end. It deliberately does **not** do dependencies/sequencing — every item is independent and lands in an inbox. The `program-milestone-planner-design.md` adds the DAG (`dependsOn`, `BLOCKED`, dependency-aware start) **on top of the same primitives**. Evolution path: add an optional `dependsOn` to `PlannerItem` + a "sequence these" toggle → commit creates `WorkItemDependency` rows instead of all-QUEUED → you've grown the Planner into the Program planner with no rework.

## 8. Verifying the breakdown is correct (plan quality)

Separate two questions:
- **(A) Is the *feature* implemented right?** → ordinary tests: endpoint unit/integration tests, the "item lands in the **right** inbox" assertion (target-capability filter), delegation/`originType`, idempotency, partial-failure. `verify` skill / CI. Not the hard part.
- **(B) Is the *breakdown* correct?** → **plan quality.** No single oracle. Use a layered **gate stack + feedback loop**.

### Rubric — define "correct" explicitly (the critic + the human both check exactly this)
A breakdown is correct when it is: **complete** (covers the whole goal), **faithful** (adds no scope not in the description), **non-overlapping** (no duplicate items), **right-sized & actionable** (each independently doable with clear acceptance), and **correctly assigned** (the capability that actually owns that work).

### Per-invocation gates (verify each breakdown before commit)
1. **Deterministic (no LLM, instant):** schema-valid (zod); every `capabilityId ∈ allowed set` (no hallucination); count ≤ `maxItems`; **near-duplicate detection** (normalize title+description, flag cosine > threshold); **requirement coverage** — extract requirement phrases/nouns from the description, flag any referenced by **no** item (a cheap completeness proxy).
2. **LLM critic — an *independent* call, NOT the planner.** Scores against the rubric and returns **specific issues, not a number**:
   - Completeness: "list sub-goals in the description covered by **no** item."
   - Faithfulness: "list items that add scope **not** in the description" (hallucinated work).
   - Overlap: "list item pairs that substantially overlap."
   - Right-sizing: items too big (split) / too trivial (merge).
   - Assignment: "given each capability's scope, list mis-assigned items."
   Returns `{ verdict: pass|warn|fail, issues:[{ dimension, itemRef, message, fix }] }`. This reuses the **adversarial-verify pattern** already in the workflow engine and the **synthetic-verifier** idea in context-fabric (`verify_synthesis.py`). For high assurance, run a **critic panel** (3 critics, distinct lenses, majority vote) — v1 = one critic.
3. **Reconstruction test (strong completeness signal):** ask a verifier to **restate the original goal using ONLY the work items**, then semantic-diff against the real description. What the reconstruction omits ≈ what the breakdown missed.
4. **Human gate (the practical v1).** The preview→commit step **is** the verification step: surface gates 1–3 **inline** in the review table — "⚠ goal mentions 'audit log' — no item covers it", "⚠ #2 overlaps #5", "⚠ #4 looks too large — split?". The human edits **with assistance** and confirms. Verification here = **assisted human approval**, not a black-box pass/fail.

### System / regression verification (is the planner *capability* good over time)
5. **Self-consistency:** run the planner N× (temperature/seed); items stable across runs = high-confidence, singletons = flag. Cheap robustness signal.
6. **Golden eval harness (offline/CI):** a set of `description → expected decomposition` goldens + a scorer (requirement-coverage recall, assignment accuracy, dup rate, count sanity), run on **every prompt/model change** so the planner can't silently regress. Natural fit for a **workflow** (fan-out goldens → planner → score → aggregate).
7. **Downstream outcome metrics (the real ground truth):** correctness is ultimately what owners *do* with the items — track the rate of items **cancelled-as-duplicate**, **re-assigned** to another capability, **split** into sub-items, and goals that needed a **follow-up "missed work"** item. These are the planner's empirical precision/recall; feed them back as eval data + prompt tuning.

> **v1 verification** = deterministic checks + **one** independent LLM critic surfaced inline + human approve/edit. **v2** = critic panel + reconstruction + self-consistency. **Ongoing** = golden evals + downstream-outcome metrics. There is no single oracle — correctness is a gate stack anchored by the human approving the preview, plus a feedback loop that learns from what owners do with the items.

## 9. Gaps & risks (self-review)
1. **LLM JSON reliability** — zod-validate + **one re-ask** + surface raw text on second failure (don't hard-crash). Use a low temperature.
2. **Capability hallucination** — the model may emit an id not in the list. **Server re-validates** every `capabilityId ∈ assignable set`, else falls back to self. (In §3.1 step 4.)
3. **Authorization to delegate** — appearing in a child's inbox is delegation. v1 reuses the governing-capability filter; **add an explicit check** that the user/parent is permitted to delegate to that child (don't let Planner route work into arbitrary capabilities). Decision needed (see below).
4. **Partial commit failure** — `Promise.allSettled`; return `failed[]`; keep the proposal so the user can retry only the failures.
5. **Double-create** — idempotency per `plannerSessionId` + disable button after submit.
6. **Over-decomposition / runaway** — cap `maxItems` (≤20) server-side; the breakdown is one bounded governed turn (`outputTokenBudget`), and `usage` is shown.
7. **Cost visibility** — return `usage` from the turn so the user sees what the breakdown cost.
8. **Empty/garbage description** — min length + a guard that returns a friendly "describe a bit more" rather than a degenerate plan.
9. **Inbox latency** — items show on InboxPage's 15s refetch; navigating to `/runtime` after commit triggers an immediate fetch, so it feels instant.

## 10. Decisions needed before build
1. **Preview-then-commit (recommended) vs one-shot auto-create** — review/edit step, or just create immediately from the agent's output?
2. **Delegation authorization** — may the Planner create items in *any* non-governing child, or only children the user is a member/owner of? (Affects the assignable set + a server check.)
3. **Prompt home** — a `PLANNER` profile in prompt-composer (consistent, editable, governed) vs an inline system prompt in the endpoint (fewer moving parts for v1).
4. **PlannerSession now or later** — persist proposals (audit/history/idempotency) in v1, or stay stateless?

## 11. Phased build
- **Phase 1 (vertical slice):** `POST /planner/breakdown` (+ inline prompt) → `PlannerPage` describe+review → `POST /planner/commit` looping `createWorkItem`. Self-capability only. Ships the core loop.
- **Phase 2:** child-capability discovery + per-row `CapabilityPicker` + delegation (`PARENT_DELEGATED`) + governance/authorization guard.
- **Phase 3:** `PlannerSession` (history, idempotency, refresh-survival) + `usage`/cost display + re-ask robustness.
- **Phase 4 (bridge to program design):** optional `dependsOn` on items → create `WorkItemDependency` + sequenced execution (hands off to `program-milestone-planner-design.md`).

---
*Lightest viable path: two endpoints + one page + one prompt, all over existing `executeGovernedTurn` + `listCapabilityRelationships` + `createWorkItem` + the Inbox. The only genuinely new artifacts are the two planner endpoints and the prompt.*
