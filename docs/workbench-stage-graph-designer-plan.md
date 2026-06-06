# Plan: Workbench Stage‑Graph Editor (in the Workgraph Designer)

## Problem
A workbench (agent‑loop) workflow is authored today as **one monolithic
`WORKBENCH_TASK` node** whose `config.workbench.loopDefinition` JSON holds *all*
stages. In the designer that surfaces as the **`WorkbenchStageBuilder` accordion**
(`apps/web/src/features/workflow/NodeInspector.tsx` ~1563–2300) — stages are inline
text rows with nested expandable sections. It's hard to see the flow and hard to
configure. Operators want to **add agentic stages one at a time, connect them,
group them into phases, and configure each visually** — i.e. treat each stage as
a first‑class node on a canvas, like the main designer.

## Key finding — this is almost entirely frontend
The backend already models stages first‑class and exposes full CRUD. **No new
data model, no runtime change, no migration** is required for the core editor.

| Layer | State | Notes |
|---|---|---|
| **Schema** | ✅ done | `WorkbenchDefinition`, `WorkbenchStage`, `WorkbenchStageEdge`, `WorkbenchExpectedArtifact`, `WorkbenchStageQuestion`, `WorkbenchArtifactConsumes` (`schema.prisma` 2183–2366). |
| **API** | ✅ done | `workbench-definitions.router.ts` mounted at `/api/workflow-nodes/:nodeId/workbench`: `GET /`, `PATCH /`, `POST/PATCH/DELETE /stages`, `POST /stages/reorder`, `POST/PATCH/DELETE /artifacts`, `POST/DELETE /edges`, `POST/DELETE /consumes`, `GET /export-copilot`. |
| **Write‑through** | ✅ done | Every mutation calls `writeThroughToLegacy(nodeId)` → rebuilds `node.config.workbench.loopDefinition` from the tables, so the **blueprint runtime is untouched**. JSON→tables promotion runs lazily on `getDefinition`. |
| **Governance reconcile** | ✅ done | Per‑stage governance fields reconcile to IAM scope=STAGE attachments after each mutation (gated by `GOVERNANCE_STAGE_RECONCILE_ENABLED`). |
| **Read‑only canvas** | ✅ exists | `WorkbenchMiniCanvas.tsx` already draws the stage graph (FORWARD solid, SEND_BACK dashed) from `GET …/workbench`; `onSelectStage` is a stub. |
| **Editable canvas** | ❌ to build | The work. |
| **"Phases" grouping** | ❌ gap | `WorkbenchStage` has `ordinal` but **no phase field** — see "Open gap" below. |

Designer stack: **React Flow v12** (`WorkflowStudioPage.tsx`).

## Architecture
Open a **Workbench‑profile** workflow in the workgraph designer → instead of (or
on drill‑in from) the single `WORKBENCH_TASK` node, show an **editable React Flow
stage canvas** backed entirely by the M84 `…/workbench` API. The canvas IS the
editor; the legacy accordion is retired (kept behind a flag during rollout).

```
React Flow stage canvas ──(REST)──▶ workbench-definitions API ──▶ workbench_* tables
        ▲                                      │
        │ getDefinition view                   ├─▶ writeThroughToLegacy → node.config.loopDefinition → BLUEPRINT RUNTIME (unchanged)
        └──────────────────────────────────────┴─▶ reconcileStageGovernance → IAM scope=STAGE
```

### Stage node ↔ data mapping (all fields already on `WorkbenchStageView`)
`stageKey`, `label`, `agentRole`, `agentTemplateId`, `contextPolicy`
(`STORY_ONLY|REPO_READ_ONLY|CODE_EDIT|VERIFY_ONLY|EVIDENCE_REVIEW`), `toolPolicy`
(`NONE|READ_ONLY|MUTATION|VERIFICATION`), `repoAccess`, `required`, `terminal`,
`approvalRequired`, `promptProfileKey`, `positionX/Y`, governance fields, plus
nested `expectedArtifacts[]`, `questions[]`, and `consumes[]`.

### Edge model
- **FORWARD** — 1 per stage (the `next` chain). Creating a FORWARD edge replaces
  any existing FORWARD from the source (service enforces this).
- **SEND_BACK** — many‑to‑many (`allowedSendBackTo`). Render dashed/amber.
- Unique `(fromStageId, toStageId, kind)`.

## Component plan (`apps/web/src/features/workflow/`)
1. **`WorkbenchStageCanvas.tsx`** (new) — editable React Flow graph. Replaces the
   read‑only `WorkbenchMiniCanvas` role:
   - Loads `GET …/workbench`; maps `stages`→nodes (`positionX/Y`, fallback to
     `ordinal`‑based auto‑layout), `edges`→RF edges (FORWARD/SEND_BACK styling).
   - Add stage (palette / "＋ Stage" → `POST /stages`), delete (⌫ → `DELETE
     /stages/:id`), connect (drag handle → `POST /edges` with kind picker
     FORWARD/SEND_BACK), delete edge, drag‑move → debounced `PATCH /stages/:id`
     `{positionX,positionY}`.
   - Each mutation refetches the returned `WorkbenchDefinitionView` (single source
     of truth) → re‑render.
2. **`WorkbenchStageInspector.tsx`** (new, extracted from `WorkbenchStageBuilder`)
   — right‑side panel shown on stage‑node select: edit identity (key/label/role/
   template), policies (context/tool/repo), flags (required/terminal/approval/
   markDone), promptProfileKey, governance, and the artifacts/questions sub‑editors
   (reuse the existing form fields → `POST/PATCH/DELETE /artifacts`, questions via
   `PATCH /stages`, `pinConsumes`).
3. **`WorkbenchDefinitionHeader.tsx`** (new/extracted) — definition‑level fields
   (`name`, `goal`, `sourceType/Uri/Ref`, agent bindings, `maxLoopsPerStage`,
   `maxTotalSendBacks`, `gateMode`, `finalPackKey`) → `PATCH /`.
4. **Designer integration** — when the selected node is `WORKBENCH_TASK` (or the
   workflow `profile === 'workbench'`), `NodeInspector` renders the
   `WorkbenchStageCanvas` (drill‑in/expand) instead of the accordion. Reuse the
   designer's React Flow instance/styles for consistency.

## Phasing (frontend slices)
- **P1 — Editable canvas core**: nodes + edges from `getDefinition`; add/delete
  stage; connect/delete FORWARD + SEND_BACK; drag‑position persist. Read‑only
  fields shown on the node chip (role, policies, terminal).
- **P2 — Stage inspector**: full per‑stage config form on node‑click → `PATCH
  /stages`. Validation (stageKey UPPER_SNAKE unique; exactly one terminal; no
  orphan stages; FORWARD forms a single chain).
- **P3 — Artifacts, questions, consumes**: per‑stage artifact CRUD, question CRUD,
  and the artifact‑handoff (`consumes`) pinning UI.
- **P4 — Phases** (needs the backend addition below): phase lanes you can
  add/name and drop stages into; visual grouping + collapse.
- **P5 — Cutover & polish**: retire the accordion behind a flag, auto‑layout for
  legacy one‑node workflows (promotion already populates tables), copy‑export
  button reuse, empty‑state ("＋ Add first stage"), undo affordances.

## Open gap — "phases"
`WorkbenchStage` has **no phase field** (only `ordinal`). To support "add a phase
and group stages" we need a small backend addition (the only backend work in this
plan):
- **Option A (lean):** add `phaseKey String?` + `phaseLabel String?` to
  `WorkbenchStage` (+ migration); P4 groups by `phaseKey`. Write‑through can ignore
  it (runtime doesn't need phases) or fold it into stage metadata.
- **Option B (first‑class):** a `WorkbenchPhase` table (id, definitionId, name,
  ordinal, color) + `WorkbenchStage.phaseId`. Mirrors `WorkflowDesignPhase` in the
  main designer; more work, cleaner long‑term.
- **Recommendation:** start P1–P3 (no backend change), decide A vs B before P4.
  Default to **A** unless phases need their own ordering/colour metadata.

## Data‑flow / runtime safety
- The editor **never** touches `node.config` directly — only the `…/workbench`
  API, which write‑throughs to `loopDefinition`. So in‑flight and future runs read
  a consistent loop. (Confirm `WORKBENCH_TABLES_AUTHORITATIVE` is off so
  write‑through stays active until M84.s6 cutover.)
- Governance reconcile fires automatically per mutation — per‑stage governance
  edits in the inspector flow to IAM scope=STAGE attachments.

## Risks / decisions to confirm
1. **Drill‑in vs inline**: does the workbench node *expand into* its stage canvas
   (recommended — keeps the main graph clean), or replace the whole designer view
   when a workbench workflow is open? → confirm UX.
2. **Phases**: Option A vs B (above).
3. **Accordion retirement**: keep both behind a flag during P1–P4, remove at P5.
4. **Auto‑layout**: legacy workflows have no `positionX/Y` → need a deterministic
   `ordinal`‑based layout on first open (then persist positions).
5. **Validation severity**: block save on invalid graph (two terminals, orphan,
   broken FORWARD chain) vs warn‑only.

## Verification
- Per slice: `tsc --noEmit` on `apps/web`; manual drive on the running designer
  (hot‑reload). For mutations, assert the returned `WorkbenchDefinitionView` and
  that `node.config.workbench.loopDefinition` regenerates (spot‑check via
  `GET /workflow-templates/:id` or the runtime).
- End‑to‑end: edit a stage graph → run the workbench loop → confirm the runtime
  honours the edited stages/edges/artifacts.

## Bottom line
No backend/runtime/migration work for the core (P1–P3) — it's an editable React
Flow canvas + a per‑stage inspector over an already‑complete API. Only "phases"
(P4) needs a small schema add. Estimated as 4–5 frontend PRs.
