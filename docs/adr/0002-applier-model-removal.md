# ADR 0002: Applier-model — removal, not restoration

## Status

Accepted. (Closes pending decision tracked as task #90 since the M74 quality
plan landed.)

## Context

The "applier-model" was an optimization shipped in commit `4988f3a`
(2026-05-20) inside the now-legacy `/mcp/invoke` endpoint. The pattern:

1. The **planning** LLM (typically a strong model — Opus/Sonnet) reasons
   about the change and emits a draft.
2. When the planner finishes with `finish_reason="stop"` and the request
   carries `applierModelAlias`, mcp-server makes a **second** LLM call to
   a smaller/cheaper model (Haiku-class) whose only job is to translate
   the draft into surgical `apply_patch` / `replace_text` tool calls.
3. The applier's output goes back through the normal mcp-server tool
   dispatcher.

The live code is at `mcp-server/src/mcp/invoke.ts:1369–1450`, with the
applier system prompt cached via prompt-composer's `mcp.applier-system`
key. Discovery (`mcp-server/src/mcp/discovery.ts:101, 391`) advertises
`applierModelSupport: true` and exposes `applierModelAlias` as a per-
request schema field.

The pattern was **never** ported to the M71 governed loop in
`context-fabric/services/context_api_service/app/governed/`. Today every
workbench coding stage and every workflow `AGENT_TASK` node that opted
into the governed flow routes through that single-model path. The
applier-model code path is only reachable via legacy `/mcp/invoke`
callers — predominantly internal scripts and the in-flight migration
work tracked as architecture-gap #1 (task #119).

The pending question this ADR closes: **port the applier-model into the
governed loop (architectural symmetry + cost savings), or let it die with
`/mcp/invoke`?**

## Decision

**Remove. Do not port.**

Concretely:

1. **Code stays where it is for now** — removing it would require
   touching `/mcp/invoke` itself, which has its own deprecation timeline
   (M71 Slice I left it as a 410-shim for some paths; full removal is
   gated on task #119). When `/mcp/invoke` goes, the applier dispatch in
   `invoke.ts:1369–1450` goes with it. No separate removal commit needed.
2. **Discovery flag flipped** — `mcp-server/src/mcp/discovery.ts` should
   start advertising `applierModelSupport: false` so any in-flight
   callers stop trying to opt in. This is a one-line change that's
   safe to ship independently and signals the end-of-life. _(Deferred
   to a follow-up commit alongside this ADR; the ADR itself is the
   binding decision.)_
3. **No equivalent in the governed loop** — the governed loop's phase
   architecture is the replacement. The PLAN phase produces structured
   intent (file list, test strategy), and the ACT phase calls mutation
   tools directly on that intent. There is no separate "draft → apply"
   step that a second model could optimize.

## Consequences

### Why this is the right call

- **Phase architecture obsoletes the pattern.** A second model would
  add a turn between PLAN and ACT, duplicating the planner's reasoning.
  In the legacy single-loop flow the applier was useful because the
  planner held tool-use, plan text, AND apply step in one rolling
  context; in the phased flow these are already separated.
- **Cost savings are marginal at platform scale.** A typical applier
  call is ~50–150 tokens of output; running it on Haiku vs. Opus saves
  ~$0.001–$0.003 per dev-stage attempt. The real cost levers are
  context compaction (already in context-fabric's prompt composer) and
  prompt caching (already in llm-gateway). LLM proliferation has
  diminishing returns once those are tuned.
- **Operational complexity drops.** Each model alias is one more thing
  to budget, audit, monitor, A/B test, and explain in incident reviews.
  Removing one moving part removes those obligations.
- **Verification pattern is the safer optimization.** M74 Phase 1A's
  auto-verify (run tests after the mutation lands) catches the failure
  modes a "double-check with a second model" would have caught, and
  catches them deterministically rather than probabilistically.

### What we give up

- **Cost optimization on the legacy `/mcp/invoke` path** — anyone still
  using it loses access to Haiku-class apply. Acceptable: this path is
  scheduled for full deprecation under task #119 and the migration to
  governed.
- **The hypothesis "specialized small models are useful for narrow
  tasks."** This ADR is specifically about the *applier* role; nothing
  here precludes future use of small models elsewhere (e.g. embedding
  generation, prompt assembly heuristics, audit-event triage).

### Operational follow-ups

- **Task #84** (governed_step eval harness) is the better place to
  spend the budget that would have gone into restoring applier-model.
  The harness gives the platform a way to measure whether *any*
  optimization actually moves quality metrics, replacing argument-by-
  authority with data.
- **`applierModelAlias` schema field** stays accepted in `/mcp/invoke`
  requests for backward compatibility but becomes a no-op at the same
  time the discovery flag flips. Callers that pass it get a warn-log,
  not a hard refusal.

## References

- Origin commit: `4988f3a feat: implement coding agent best practices in mcp-server` (2026-05-20)
- Live code: `mcp-server/src/mcp/invoke.ts:1369–1450`
- System prompt cache: `mcp-server/src/mcp/invoke.ts:618–644` (uses prompt-composer `mcp.applier-system` key)
- Discovery advertisement: `mcp-server/src/mcp/discovery.ts:101, 391`
- Replacement architecture: `context-fabric/services/context_api_service/app/governed/loop.py` (phase-based, single-model)
- M74 quality plan reference: `docs/M74-quality-plan.md:471` ("Decide on applier-model — Blocked on Phase 4")
- Companion: task #119 (legacy `/mcp/invoke` deprecation) — the natural carrier for the actual code removal.
