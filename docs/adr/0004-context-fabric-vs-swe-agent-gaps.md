# ADR 0004: context-fabric vs SWE-agent/Aider — fact-check of claimed gaps

## Status

Accepted (analysis / verification record). No code change proposed — this ADR
records the verdict on three externally-claimed limitations so the design
posture is documented and the claims don't get repeated uncorrected.

## Context

A comparison circulated asserting three limitations of context-fabric relative
to SWE-agent / Aider:

1. **Rigid linear flow** — `PLAN → EXPLORE → ACT → VERIFY`; a failed VERIFY
   *forces* the agent into REPAIR and it *cannot re-enter general EXPLORE
   reading routines*.
2. **No sandbox isolation** — SWE-agent spins a fresh Docker container per
   issue; context-fabric dispatches tools to a *shared local workspace*, so
   concurrent sub-agents are *susceptible to file locks and test-state
   corruption*.
3. **Prompt-cache overhead** — dynamic per-phase tool allowlists change the
   tools schema across phase boundaries; because *tool definitions are part of
   the Anthropic system prompt*, shifting phases *invalidates the prompt-cache
   prefix*, raising transition latency.

Each was checked (read-only) against the current code. Verdict: all three are
outdated or incorrect; #2 and #3 are flatly contradicted by the code, #1 is
misleading on its headline.

## Decision (findings)

### Claim 1 — "Rigid linear flow / forced REPAIR / no re-exploration" → MISLEADING

- **Topology is a graph, not a line.** `context_api_service/app/governed/
  phase_state.py` `_ALLOWED_TRANSITIONS` (~lines 62–102) includes back-edges and
  self-loops: `EXPLORE→PLAN` (scope error), `EXPLORE→EXPLORE`, `VERIFY→VERIFY`,
  `REPAIR→VERIFY`, `SELF_REVIEW→REPAIR`, plus stage-shape edges (`PLAN→
  SELF_REVIEW`, `EXPLORE→VERIFY` for QA).
- **VERIFY-fail is not "forced" into REPAIR.** The agent declares `next_phase`
  via `submit_phase_output`; on a failed verification receipt the orchestrator
  only *refuses* a `VERIFY→SELF_REVIEW` skip (`loop.py`, the VERIFY gate) and
  instructs the agent to advance to REPAIR or set `risk_policy.allow_unverified`.
- **Read/explore tools are NOT blocked in REPAIR.** `tool_gateway.
  allowed_tools_for` is driven by the seeded StagePolicy, which includes read
  tools (`read_file`, `grep`, `symbol_search`, `repo_map`). The
  `_MUTATING_PHASES = {ACT, REPAIR}` flag (`stage_driver.py`) only affects which
  calls count as "progress," not access. REPAIR is also capped
  (`max_repair_attempts`, default 3), not an infinite trap.
- **Fair residual:** there is no `REPAIR→EXPLORE` edge, so the EXPLORE *phase*
  can't be formally re-entered mid-repair. The headline ("cannot do exploratory
  reading") is nonetheless false.

### Claim 2 — "Shared workspace / concurrency corruption" → FALSE

Three independent isolation layers:

- **Filesystem:** each WorkItem gets its **own git worktree** under
  `.singularity/workitems/<id>/` — `mcp-server/src/workspace/
  source-materializer.ts` (`git worktree add`) + `sandbox.ts` layout (M81 P2:
  one worktree per WorkItem on a `wi/<code>` branch).
- **Execution:** test/command runs go to **ephemeral per-run Docker containers**
  — `mcp-server/src/runner/docker-exec.ts` (`docker run --rm --read-only
  --cap-drop ALL`, network/cpu/mem limits), not the host process.
- **Concurrency:** `withWorkspaceLock` (`sandbox.ts`, exclusive
  `workspace.lock`) + a workgraph-api no-parallel-attempts guard serialize
  access to a WorkItem's worktree.

Not "a fresh container per issue" like SWE-agent, but the corruption mechanism
the claim describes is actively prevented.

### Claim 3 — "Per-phase allowlists bust the prompt cache" → FALSE (premise wrong)

- **Premise is wrong:** tools are a **separate top-level `tools` array**, not
  embedded in the system prompt — `llm_gateway_service/app/providers/
  anthropic.py` `respond()` builds distinct `body["system"]` and `body["tools"]`.
- **Per-phase filtering never reaches the wire:** `context_api_service/app/
  governed/turn.py` `_build_tool_descriptors` (M72A) sends a **sorted UNION of
  every phase's tools**, stable for the whole stage; each tool carries a
  `phase_scope` hint and out-of-phase calls are refused **server-side**
  (`tool_gateway.check_tool_allowed`). Its docstring states this was the M72A
  fix for *exactly* this cache-invalidation problem ("Before M72A: phase
  transitions changed the tools[] block → cache prefix invalidated … After
  M72A: tools[] stable across the whole stage").
- **Cache breakpoints** (ADR 0003) sit on the last tool + system block
  (Anthropic order tools→system→messages); the sorted union keeps the prefix
  byte-stable across `PLAN→…→FINALIZE`. A phase transition does not change the
  tools array, so it does not invalidate the cached prefix.

## Consequences

- The claimed "gaps" should not be cited as current limitations. The kernel of
  truth is that context-fabric is **governance-first**: phase-structured intent,
  per-WorkItem (not per-issue) worktrees + sandboxed runner containers, and
  server-side tool fencing. That is a deliberate posture, not the failure modes
  asserted.
- **Genuine residual (the only fair point):** no `REPAIR→EXPLORE` phase edge.
  If organic "fail → go read more → re-plan" debugging proves valuable, adding
  that edge (and/or a REPAIR→PLAN edge) is the targeted change — tracked
  separately, not adopted here.

## Caveats on this verification

- Claims 1 and 2 are verified by reading the code paths above. Claim 3's cache
  behavior is confirmed at the **code level**, not measured against a live
  Anthropic response; an empirical check of `cache_read_input_tokens` across a
  real phase transition would settle it definitively.
- Line numbers are approximate (`~`); verify by content/symbol, not line.

## References

- `context_api_service/app/governed/phase_state.py` — `_ALLOWED_TRANSITIONS`
- `context_api_service/app/governed/{loop,turn,stage_driver,tool_gateway}.py`
- `mcp-server/src/workspace/{source-materializer,sandbox}.ts`,
  `mcp-server/src/runner/docker-exec.ts`, `docker-compose.yml` (mcp-sandbox-runner)
- `context-fabric/services/llm_gateway_service/app/providers/anthropic.py`
- ADR 0003 (server-level prompt caching) — cache_control placement
