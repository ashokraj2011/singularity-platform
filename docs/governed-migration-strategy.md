# Workflow → governed migration strategy

**Status**: Design + scaffold. Task #119. Implementation deferred to its own milestone.

## Problem

The M71 cutover replaced `/mcp/invoke` with the governed loop at
context-fabric. Workbench coding stages call it via
`runCodingStageGoverned` in `blueprint.router.ts`. But three
non-blueprint code paths still call the legacy
`contextFabricClient.execute`:

- **`workgraph-studio/apps/api/src/modules/workflow/runtime/executors/AgentTaskExecutor.ts`** — every workflow `AGENT_TASK` node. Biggest blast radius.
- **`workgraph-studio/apps/api/src/modules/contracts/contracts.router.ts`** — design-time contract preview/test. Low traffic.
- **`workgraph-studio/apps/api/src/modules/event-horizon/event-horizon.router.ts`** — long-running event-horizon planning runs. Medium traffic.

Plus the embedded `/execute` callers inside the executor itself
(line 5061 of `blueprint.router.ts`) used by some legacy stage types.

## What's already scaffolded

`AgentTaskExecutor.ts` now parses a `cfg.useGovernedExecutor` node-config
flag. When `true`, the executor **fails fast** with a clear operator
error pointing here. When unset/false, the existing legacy path runs
unchanged. This means:

- No production traffic shifts until the rest of this doc is implemented.
- The migration *mechanism* (config flag + opt-in entry point) is in
  the code, so a future operator session just needs to flip the boolean
  and run the adapter work.
- An operator who sets the flag without the adapter sees a clear
  error instead of a silent fall-through.

## What still needs to land — implementation checklist

### Phase 1 — Response-shape adapter (~2 days)

The governed endpoint returns `GovernedStageResponse`
(`{stop_reason, turns, final_state, totals, ...}`). The rest of
`AgentTaskExecutor.ts` expects `ExecuteResponse`
(`{status, finalResponse, correlation, tokensUsed, usage, ...}`).
The existing adapter for `runCodingStageGoverned` lives at
`workgraph-studio/apps/api/src/modules/coding-agent/orchestrator.ts:321`
(`adaptGovernedStageToCodingRun`); the workflow path can either:

- **Reuse** that adapter (cleanest; one shape, one set of tests).
- **Build a parallel adapter** when AGENT_TASK needs fields the
  CodingRunResult shape doesn't carry.

Decision: **reuse, then extend if a real field is missing**. The
adapter already pulls verification receipts + code_change_ids out
of turn outcomes; AGENT_TASK shouldn't need more.

### Phase 2 — Stage policy resolution (~1 day)

`runCodingStageGoverned` needs `policy: CodingStagePolicy`. The
existing `classifyCodingStagePolicy()` in `blueprint.router.ts` does
this from a stage definition; the workflow path has *node config*
(`cfg.contextPolicy`, `cfg.toolPolicy`, etc.), not a stage def.
Two options:

- **Wrap** the node config in a synthetic `LoopStageDefinition` so
  `classifyCodingStagePolicy()` works unchanged.
- **Write** a parallel classifier for nodes.

Decision: **wrap**. The shape coercion is ~30 LOC; a parallel
classifier would drift over time.

### Phase 3 — StagePolicy DB seeding for workflow nodes (~1 day)

The governed path requires a `StagePolicy` row in prompt-composer
keyed by `(stageKey, agentRole)`. Workflow nodes don't have a
stageKey today — they have `nodeType: AGENT_TASK` + a role. We need:

- A migration that seeds default StagePolicy rows for the common
  workflow node roles (DEVELOPER, QA, ARCHITECT, etc.) under
  synthetic stageKey `workflow.<role>`.
- A resolver in the workflow path that maps `(node.nodeType, node.role) → stageKey`.

Coupled with policy revision: prompt-composer's UI needs to surface
"workflow stages" as a tab alongside the existing "blueprint stages"
so operators can edit them.

### Phase 4 — Error code mapping (~half day)

The legacy path throws `ContextFabricError` with codes
`MCP_NOT_CONNECTED`, `MCP_LAPTOP_TIMEOUT`, `GOVERNANCE_UNAVAILABLE`,
`CONTEXT_PLAN_INVALID`. The governed path uses different codes (or
none — most failures land in `result.stop_reason`). The adapter must:

- Translate `stop_reason: "POLICY_BLOCKED"` → friendlier message.
- Translate `stop_reason: "LLM_ERROR"` + `error_code: "MCP_NOT_CONNECTED"` → same operator copy as today.
- Keep the existing `failRun(run.id, code, message)` shape so the
  Workbench UI doesn't lose its error-card rendering.

### Phase 5 — Rollout (~1 week calendar, ~half day code)

1. Land Phases 1–4 + tests.
2. Update the AgentTaskExecutor stub: `cfg.useGovernedExecutor=true` → run the new path.
3. Flip ONE low-risk workflow (e.g. an internal QA workflow) by editing the node design.
4. Watch audit-gov for a week. Look for `stop_reason: POLICY_BLOCKED` spikes (workflow nodes hitting unfamiliar phase enforcement).
5. Roll forward to higher-traffic workflows in waves.
6. After 4 weeks at 100% on governed, retire the legacy path + delete the flag.

### Phase 6 — Sibling routers (~1 day each)

`contracts.router.ts` and `event-horizon.router.ts` follow the same
pattern but with simpler integration (no workflow correlation, no
node config). After Phase 5 lands, port these directly without a
flag — their traffic is small enough that operators can re-run if
something goes sideways.

## Why this is scoped as scaffold + doc, not implementation

Each phase is independently risky. The scaffold + doc let an operator
who picks this up tomorrow see:

- Exactly which code changes need to land + in what order.
- The decision rationale on every fork (reuse vs parallel, wrap vs
  rewrite).
- A rollout sequence that doesn't require a flag day.

Shipping the implementation as a single PR — without the doc — would
hide all those decisions inside review comments. Shipping the doc
without the scaffold would leave the actual migration mechanism
ungrounded in code. Both together = the next session has everything
it needs to execute.

## Rollback plan if it goes wrong

`cfg.useGovernedExecutor=false` on every node = back to the legacy
path. No DB rollback needed. The audit trail makes it trivial to
identify which nodes ran which path during the migration window
(`source_service:workgraph-api` + the new `executor_mode: "governed" | "legacy"` field
in the audit-gov event payload).

## Open questions

- **Per-stage cutover or per-workflow?** A workflow can have multiple
  AGENT_TASK nodes. Flipping the flag on one node and not the others
  mid-workflow seems fine — the workflow engine treats nodes
  independently — but should be exercised in a dev workflow first.
- **What about `EvalGateExecutor` and `ApprovalExecutor`?** They call
  audit-gov, not context-fabric. Unaffected by this migration.
- **Does `runCodingStageGoverned` support `preview_only`?** The
  legacy path has a `preview_only` flag that drafts a response
  without persisting receipts. The governed path doesn't. If any
  production workflow uses preview_only on AGENT_TASK, that's a
  blocker for migration of that workflow.

## Tracking

- Task **#119** — implementation of Phases 1–5 above.
- This doc — design + scaffold + rollback contract.
- Sibling: `docs/M75-mcp-bearer-rotation.md` for the bearer-token
  rotation that should happen during the same milestone (both touch
  the same audit-gov event surface).
