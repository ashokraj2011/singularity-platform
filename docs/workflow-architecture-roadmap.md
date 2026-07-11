# Workflow architecture roadmap — the "best of its kind" tier

The reliability + explainability themes shipped as PRs (WF-1…WF-6) and risk-based
governance as WF-7. This doc designs the four remaining **architectural** themes — each a
real rearchitecture that must be built where its tests + staging exist, not blind. They are
grounded in the current code and sequenced by dependency.

Dependency graph: **① durable execution** unlocks **④ time-travel**; **② sandbox verify**
feeds **WF-7 confidence-gating**; **③ semantic grounding** feeds on the **WF-3/WF-4** trust
data. ① and ② are the highest leverage.

---

## ① Event-sourced durable execution (Theme 1 endgame)

**Problem.** `WorkflowRuntime` is a synchronous recursive chain (`advance → activateDownstream
→ executeServerNode → advance`); resume leans on DB *state*, not a replayable history. WF-1
(watchdog) and WF-2 (atomic completion/resume) hardened the failure modes, but a crash
mid-`advance` still can't be *deterministically replayed*.

**Design.** Promote the transition log to the source of truth. `workflow_mutations` already
records `NODE_RETRY` / `INSTANCE_STATUS_CHANGE` / etc. — make it (or a new `workflow_events`)
**append-only + totally ordered per instance**, and derive current state as a **fold** over it.
Resume = replay from the last checkpoint. Side-effects become idempotent commands keyed by
`(nodeId, attempt)` (the `_attempts` fence already exists) so replay never double-fires.

**Reuse:** `workflow_mutations`, the `_attempts` fence, the atomic claims from WF-2
(`finalizeInstanceCompletion`) + `TimerSweep`.

**Sequence:** (a) complete + order the mutation log; (b) build a pure reducer that rebuilds
instance/node state from the log; (c) add a `resumeFromLog` path **beside** today's DB-state
resume and **shadow-compare** the two on every run; (d) cut over once they match in staging.

**Risk:** high. The shadow-compare in (c) is the safety net — never cut over until log-derived
state == DB state for a sustained window.

---

## ② Sandbox-verified autonomy (Theme 3 execution)

**Problem.** The Part-B verify verdict records agent-reported exit codes as *attestations*; it
does not independently re-run anything. WF-7 confidence-gating then trusts a confidence signal
— which is only as good as its source. Best-in-class: the platform **re-runs tests/build on the
produced artifact** and derives the verdict itself.

**Design.** A post-produce verify step: given the produced branch/commit, spin an **ephemeral
isolated sandbox**, run the capability's `testCommands`/`buildCommands` (from
`CapabilityWorldModel`), capture pass/fail + coverage, and write it as the `_verification`
signal WF-7 already consumes — closing the loop *(real verification → confidence → autonomy)*.

**Reuse:** `CapabilityWorldModel.testCommands/buildCommands`, the central materializer
(`/mcp/source/ground`, D3) for the clone, the git broker, the Part-B verdict shape
(`copilot-results-verify`), `VerifierExecutor`.

**Risk:** this **runs customer code** → mandatory container isolation (no host access, egress
allow-list, CPU/mem/time caps) — the same "dynamic grounding" boundary flagged in
`docs/central-grounding.md`. Needs sandbox infra; ship behind a flag, low-criticality first.

---

## ③ Semantic / graph-aware code grounding (Theme 5)

**Problem.** Code grounding is **lexical** (`mcp-server/ast-index.ts` SQLite `LIKE`); central
code embeddings are dead-by-default; there's no call-graph and no feedback on whether grounding
actually helped.

**Design.** Three independent steps, cheapest first: (a) **graph-aware** — surface the
`dependencies` edges the AST index already stores as callers/callees/impact queries; (b)
**semantic** (optional) — tree-sitter chunks → embeddings → `CapabilityCodeEmbedding`, using the
now-fixed embedding provider (Workstream A) and the direct-to-gateway transport (D1); (c)
**feedback loop** — correlate which grounding hits preceded a run that *passed* verification
(WF-3 decision record + ② verdict) and rank future retrieval by what actually helped.

**Reuse:** `ast-index.ts` (`files/symbols/dependencies/ast_slices`), `CapabilityCodeEmbedding`,
the embedding client (A/D1), the WF-3 decision record + ② verdict for (c).

**Risk:** medium. (c) depends on ② existing (a real verdict to correlate against).

---

## ④ Simulation / versioning / time-travel (Theme 6)

**Problem.** No dry-run (preview a path + cost without real side-effects), no template
versioning with in-flight migration, no time-travel debugging.

**Design.** (a) **Simulation** — a run flag that swaps agent/tool executors for deterministic
stubs (reuse the `embed-mock` / mock-LLM pattern from Workstream A) so the engine walks the
graph and reports the path + estimated cost with **no** real LLM/tool calls; independent of the
others. (b) **Template versioning** — version `workflow_templates` + an old→new node-id
migration for in-flight instances. (c) **Time-travel** — replay a run's event log (from ①) to
any node and inspect state via the WF-3 decision record; **falls out of ① almost for free**.

**Reuse:** the executor dispatch (mockable), the mock LLM (A), ①'s event log (time-travel), the
WF-3 decision record (state inspection).

**Risk:** low–medium. (c) is gated on ①; (a) and (b) are independent.

---

## Suggested order

1. **① durable execution** — foundation + unlocks ④c (time-travel) nearly free.
2. **② sandbox verify** — makes WF-7 autonomy *earned* rather than trusted; needs sandbox infra.
3. **④a simulation** — independent, high operator value, cheap once the dispatch is mockable.
4. **③ grounding** — graph-aware first (cheap), semantic + feedback loop after ② exists.

Every one ships behind a flag, shadow/dry-run first, low-criticality capabilities first — the
same discipline as the RLS cutover, central grounding, and confidence-gating.
