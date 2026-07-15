# ADR 0006: Unified Discovery & Elicitation — a central "reduce the unknowns" capability

## Status

Proposed. This ADR defines the design; implementation is deferred to follow-up
slices (see "Rollout"). It supersedes no ADR but consolidates three existing,
uncoordinated mechanisms.

## Context

Agentic SDLC workflows begin in a **discovery** zone: the early phases where the
requirement is fuzzy, the solution space is unknown, and the system must
*elicit* information (ask clarifying questions), *research* (read code, docs,
tickets, run tools), and *record assumptions* before committing to a plan.

Today the platform handles this in **three separate, unshared mechanisms**:

1. **Studio / Workbench stage questions** — operator-authored clarifying
   questions attached to a workbench stage at *design time*. Static; the
   required ones gate stage approval.
   - Model: `WorkbenchStageQuestion` (`apps/api/prisma/schema.prisma:3033`),
     fields `stageId, questionId, text, required, freeform, options`.
   - UI: `apps/web/src/features/workflow/WorkbenchStageCanvas.tsx` (~684–704).

2. **Work-item clarifications** — ad-hoc questions raised at *runtime* against a
   work item (child→parent by default), answered by a human. Non-blocking; it is
   effectively a Q&A audit log.
   - Model: `WorkItemClarification` (`schema.prisma:1617`), fields
     `workItemId, targetId, direction, status(OPEN…), question, answer, …`.
   - API: `POST /work-items/:id/targets/:targetId/clarifications` and
     `POST /work-items/:id/clarifications/:clarificationId/answer`
     (`work-items.router.ts:539,549`).
   - UI: `apps/web/src/features/runtime/WorkDetailPage.tsx` (~447–463).

3. **LLM open-questions** — questions the model emits in its output, scraped from
   markdown headings ("Open questions", "Clarifications") during a workbench
   attempt. Non-blocking.
   - Extraction: `apps/api/src/modules/blueprint/blueprint.router.ts` (~7823–7910),
     tagged `source: 'llm_open_question'`.

**Problems with the status quo**

- **Three shapes, zero shared code.** `WorkbenchStageQuestion`,
  `WorkItemClarification`, and the in-memory `LoopQuestion` are separate models
  with separate APIs and UIs. A question raised in one place is invisible to the
  others.
- **Passive, not active.** All three only *capture* questions. None can *drive
  discovery* — none can call a model, assemble context, or run a tool to reduce
  the unknown. The "LLM open-questions" path is the closest, but it is a
  side-effect of the workbench loop, not a reusable capability.
- **No first-class assumptions.** Teams routinely proceed on assumptions; there
  is nowhere to record an assumption, its confidence, and its later validation.
- **Not portable.** None of this is reachable from the new Workflow VM
  (`@workgraph/vm`) — a packaged workflow that hits a discovery phase offline has
  no consistent way to park on unknowns.

**Available integration seams** (all verified in-repo)

- **LLM gateway (WorkGraph):** routing by *touch point* —
  `COPILOT_SDLC | WORKBENCH | CHAT | GOVERNED_AGENT | AUDIT_JUDGE`
  (`llm-routing.router.ts:42`), resolved via
  `GET /api/llm-routing/resolve?touchPoint&userId&capabilityId`.
- **Context Fabric client** (`apps/api/src/lib/context-fabric/client.ts`):
  `execute()`, `executeGovernedTurn()` (single governed turn),
  `executeGovernedStage()` (multi-turn loop). This is the one governed door to
  models, with context assembly, correlation ids, and audit.
- **Copilot:** the *same* `executeGovernedTurn` path with
  `run_context.executor='copilot'` → dispatches the `copilot_execute` MCP tool.
- **MCP tools:** `POST /mcp/tool-run` (bearer-authed, governed) for research /
  mutation tools (`mcp-server/src/mcp/tool-run.ts`).

## Decision

Introduce a **single first-class capability — Discovery** — owned by a new
`discovery` module in `workgraph-studio/apps/api`, surfaced identically in the
studio canvas and the work-item detail view, and callable from the runtime and
the Workflow VM. It **unifies the three mechanisms** behind one model and one
service, and it can **actively** reduce unknowns by talking to the LLM gateway /
Copilot / Context Fabric / MCP through the existing governed seams.

### 1. Domain model — one `Question`, plus `DiscoverySession` and `Assumption`

Replace the three parallel shapes with one normalized set (new Prisma models;
the old two are migrated and then retired — see "Migration").

```
DiscoverySession
  id, tenantId
  scopeType   : 'WORKFLOW_STAGE' | 'WORK_ITEM' | 'RUN'
  scopeId     : string            // stageId | workItemId | runId
  status      : OPEN | RESOLVING | BLOCKED | RESOLVED | ABANDONED
  createdBy, createdAt, updatedAt

Question
  id, sessionId, tenantId
  text
  kind        : 'single_select' | 'multi_select' | 'freeform' | 'clarification'
  source      : 'configured' | 'llm' | 'copilot' | 'human' | 'agent'
  blocking    : boolean           // unifies "required" gate semantics
  status      : OPEN | ANSWERED | DISMISSED
  options     : Json?             // [{label, impact?, recommended?}]
  answer      : string?
  answeredBy, answeredAt
  proposedAnswer : string?        // model/tool-proposed, pending human confirm
  confidence  : float?            // 0..1 when proposed by a model
  ordinal     : int

Assumption
  id, sessionId, tenantId
  text
  confidence  : float
  status      : PROPOSED | ACCEPTED | REJECTED | VALIDATED | INVALIDATED
  validatedBy, validatedAt, evidenceRef : Json?
```

`source` subsumes all three legacy origins; `blocking` subsumes "required".
A discovery session attaches to **either** a workbench stage **or** a work item
**or** a run via `(scopeType, scopeId)`, so the same object powers both UIs.

### 2. `DiscoveryService` — the elicitation loop (the "active" part)

A single service that runs one governed elicitation iteration and is safe to call
from server runtime *and* (via an adapter) the Workflow VM:

```
elicit(session, input) →
  1. assemble context   → contextFabricClient.execute/executeGovernedTurn
                          (touch point: DISCOVERY — new, see §3)
  2. ask the model      → same governed turn; executor='copilot' when the
                          session/stage is Copilot-routed
  3. optionally research → MCP POST /mcp/tool-run for read-only "analyzer" tools
                          (code search, ticket lookup) to answer its own questions
  4. persist            → upsert Questions (source='llm'|'copilot'|'agent',
                          with proposedAnswer + confidence) and Assumptions
  5. gate               → session.status = BLOCKED iff any blocking Question is
                          still OPEN; else RESOLVED
```

- **Governed, not raw.** All model access goes through `contextFabricClient`
  (never a direct provider call), inheriting prompt assembly, correlation ids,
  and audit — consistent with `AGENT_TASK`/workbench.
- **Fail-closed offline.** In the Workflow VM, a discovery step with an
  unreachable gateway *parks* (BLOCKED) exactly like the existing human/IAM
  degrade, rather than silently proceeding.

### 3. New LLM routing touch point: `DISCOVERY`

Add `DISCOVERY` to the touch-point catalog (`llm-routing.router.ts:42`) so
operators can route discovery/elicitation to a specific model independently of
`WORKBENCH`/`GOVERNED_AGENT`. Copilot-routed discovery uses `COPILOT_SDLC` as
today.

### 4. API (new `discovery` module)

```
POST   /discovery/sessions                       {scopeType, scopeId}      → session
GET    /discovery/sessions/:id                                             → session+questions+assumptions
POST   /discovery/sessions/:id/elicit            {hint?, budget?}          → runs one loop iteration
POST   /discovery/sessions/:id/questions         {text, kind, blocking?}   → add (human/configured)
POST   /discovery/questions/:qid/answer          {answer}                  → answer + maybe unblock
POST   /discovery/questions/:qid/dismiss
POST   /discovery/sessions/:id/assumptions       {text, confidence}
POST   /discovery/assumptions/:aid/validate      {status, evidenceRef?}
```

The existing work-item clarification endpoints become **thin adapters** that
create/answer `Question`s on the work item's `DiscoverySession` (backward
compatible), and the workbench stage-questions become **seed** `Question`s
(`source='configured'`) on the stage's session.

### 5. UI — one shared panel in two places

A single `DiscoveryPanel` React component (questions + assumptions + an "Ask /
Elicit" action) mounted in **both**:
- the studio canvas (replacing the bespoke clarifying-questions editor in
  `WorkbenchStageCanvas.tsx`), and
- the work-item detail view (replacing the bespoke clarifications list in
  `WorkDetailPage.tsx`).

### 6. Workflow node + VM support

- A `DISCOVERY` (or reuse of `WORKBENCH_TASK` with a discovery mode) node runs a
  `DiscoverySession` and blocks the workflow while blocking questions are open —
  the natural home for "figure out what we don't know" phases.
- A `@workgraph/vm` executor + a `DiscoveryAdapter` (online → Context Fabric/MCP;
  offline → park) so packaged workflows handle discovery consistently.

## Consequences

**Positive**
- One concept, one model, one API, one UI — a question/assumption is coherent
  across studio, runtime, and the VM.
- Discovery becomes **active**: the platform can research and propose answers,
  not just collect questions.
- First-class **assumptions** with confidence and later validation.
- Governance/audit is inherited for free (single Context Fabric door).
- Portable: the VM degrades discovery fail-closed like other service-bound steps.

**Costs / risks**
- **Migration** of two live models (`WorkbenchStageQuestion`,
  `WorkItemClarification`) and their APIs/UIs — must be backward compatible; the
  old endpoints stay as adapters during transition (accepted).
- **Prompt-injection / tool-safety**: discovery lets a model trigger MCP tools.
  Mitigation: elicitation defaults to **read-only analyzer** tools, reuses the
  existing MCP grant/scope model, and never auto-executes mutating tools without
  a blocking human confirmation.
- **Cost/latency**: an elicitation loop can fan out to model+tools. Mitigation:
  per-session `budget` (turns / token / tool-call caps) enforced by the service.
- **Executor duplication** between server and VM (same tension as ADR 0005) —
  tracked; the adapter-interface approach keeps the loop logic shared.

## Rollout (proposed slices)

1. **Schema + service (backend):** new models, `DiscoveryService.elicit`,
   `DISCOVERY` touch point, `/discovery/*` API; unit-tested against a mocked
   Context Fabric/MCP.
2. **Compatibility adapters:** re-point work-item clarification + workbench
   stage-question endpoints at the new model (data migration, dual-write/verify).
3. **Shared UI panel** in studio + work-item detail.
4. **Workflow node + VM executor/adapter.**

## References

- Existing mechanisms: `WorkbenchStageCanvas.tsx`, `WorkDetailPage.tsx`,
  `blueprint.router.ts` (LLM open-questions), models at `schema.prisma:1617,3033`.
- Seams: `context-fabric/client.ts` (`executeGovernedTurn`),
  `llm-routing.router.ts:42` (touch points), `mcp-server/src/mcp/tool-run.ts`.
- Related: ADR 0005 (Workflow VM) — the VM discovery adapter follows the same
  online/offline degrade pattern.
