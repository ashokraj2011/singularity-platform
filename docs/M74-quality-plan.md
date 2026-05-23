# M74 — Quality bar plan

Implementation plan for the architectural review of 2026-05-23, which
identified that the eval system is a regression detector mislabeled as
an evaluator, and that the governed loop dropped several in-loop
oracles invoke.ts used to enforce. This plan groups the fixes by
risk-reduction-per-unit-of-work and surfaces the dependencies.

## Goals, in priority order

1. **Restore the invoke.ts capabilities the cutover dropped.** The
   governed loop has cleaner architecture but is, today, more
   *permissive* than invoke.ts — verification is LLM-asserted not
   externally-checked, plan coverage isn't enforced, and several
   receipt schemas accept semantically nonsense outputs.

2. **Transform the eval system from regression-only to
   capability-aware.** Today's eval pipeline gates against past
   behavior. A model swap that produces 30% worse code but doesn't
   trigger any of the five evaluator types deploys clean. The fix is
   to enable `llm_judge` with stage-typed rubrics and to close the
   feedback loop between eval failures and the next attempt's prompt.

3. **Address long-context correctness.** History grows unboundedly,
   prompt-injection delimiters are missing, and these become more
   acute as stages get longer or stagger pause/resume.

4. **Build the offline capability harness.** The "is this model good
   at coding" question that the production gate can't answer.
   Decoupled from the workflow path; runs weekly on a fixed corpus.

Anything else — multi-turn PII restore, MCP token rotation,
applier-model decision — is tracked separately and not in this plan.

## Phase ordering rationale

```
   Phase 1 (parity) ─┐
                     ├─► Phase 2 (quality-aware eval)
                     ├─► Phase 3 (long-context)
                     │
                     └─► Phase 4 (capability harness, offline) — independent
```

Phase 1 unblocks Phase 2 — the closed-loop wiring in Phase 2 needs
verification receipts to be trustworthy, which Phase 1 fixes. Phase 3
is independent of both and can be interleaved. Phase 4 is a separate
workstream.

---

## Phase 1 — Restore dropped invoke.ts capabilities

**Effort**: 3-4 days. **Risk reduction**: highest of any phase.

### 1A — Auto-verify on mutation  (~1.5 days)

When the agent submits an `EditReceipt`, context-fabric synthesizes a
`run_test` call before transitioning to `VERIFY`, seeds the VERIFY
phase's tool history with the actual verifier output, then lets the
LLM proceed. Restores invoke.ts:1903-2090's external-oracle pattern.

Files:
- `context-fabric/services/context_api_service/app/governed/loop.py`
  — after a successful `ACT` phase advance, if the receipt is an
  `EditReceipt`, dispatch the verifier list synchronously.
- `context-fabric/services/context_api_service/app/governed/verify_synthesis.py`
  (new) — picks the verifier command via mcp-server's
  `recommended_verification` tool, dispatches it, formats the result
  as a synthetic tool-message that lands in VERIFY's history.
- `mcp-server/src/mcp/tool-run.ts` — confirm `recommended_verification`
  is registered (it is; M71 Slice E added it).

Tests:
- `tests/test_governed_loop.py` — happy path (EditReceipt → run_test
  fires → VerificationReceipt accepted), failure path (run_test fails
  → VERIFY history seeded with failure → next turn sees it).
- Boundary: ACT phase with EditReceipt that has empty edits[] should
  NOT auto-verify (no mutation occurred).

Risks:
- Doubles the worst-case latency of ACT → VERIFY transition. Mitigation:
  the verifier dispatch runs concurrently with the phase advance
  emit_governed_event call; net add is one HTTP round-trip to
  /mcp/tool-run.
- Verifier picks a wrong command. Mitigation: the LLM still owns the
  VERIFY phase — it can call additional verifiers or call
  `verification_unavailable` to override.

Decision point: do we auto-verify on REPAIR too, or only ACT? I'd say
yes — same logic, same risk shape. Adding it to REPAIR is one extra
branch in the same code path.

### 1B — Path-coverage check  (~3 hours)

`EditReceipt.edits[]` must structurally cover
`PlanReceipt.target_files[]` declared earlier in the same stage. The
agent can declare a skip explicitly via a new `skipped_targets:
[{path, reason}]` field. Restores invoke.ts's `finish_gate_premature`
check.

Files:
- `context-fabric/services/context_api_service/app/governed/receipts.py`
  — `EditReceipt` gains optional `skipped_targets: list[SkippedTarget]`.
  Add `@model_validator(mode='after')` on the stage-level coverage
  check; needs the PlanReceipt to compare against, so the validation
  has to run at advance_phase time, not on receipt construction.
- `context-fabric/services/context_api_service/app/governed/loop.py`
  — when advancing past ACT, run path_coverage_check(plan, edit) and
  refuse the advance if uncovered targets exist without skip reasons.

Tests:
- `tests/test_governed_validators.py` — plan declares 3 targets, edit
  touches 2 + skips 1 with reason → accepted; plan declares 3, edit
  touches 2 with no skips → refused; plan declares 0 → accepted (no
  coverage to enforce).

Risks: low. This is pure structural validation, no external
dependencies. Could over-refuse if the agent legitimately needs to
add a new file not in PlanReceipt.target_files — mitigation: allow
edits to files NOT in target_files (over-coverage is fine; only
under-coverage is refused).

### 1C — VerificationReceipt validator  (~1 hour)

`@model_validator(mode='after')` on `VerificationReceipt` that
refuses `status == "passed"` with `commands_run.length == 0`. Same
pattern as the SELF_REVIEW validator (e3dc361). Eliminates the
"status: passed, commands_run: []" fake-pass loophole.

Files:
- `context-fabric/services/context_api_service/app/governed/receipts.py`

Tests:
- `tests/test_governed_validators.py` — 4 cases matching the
  SelfReview pattern: passed + commands fine; passed + empty refused;
  unavailable + empty fine; failed + commands fine.

Risks: none.

### 1D — Stagnant-phase threshold fix  (~2 hours)

Change the threshold from 2 to 3 consecutive non-advancing turns AND
add a "made progress" exception: a turn counts as "progress" if it
dispatched at least one tool with a unique (tool_name, args_hash)
that hasn't been seen in the last N turns. Two turns of identical
refused calls still counts as stagnant. Two turns of different
`read_file` calls counts as progress.

Files:
- `context-fabric/services/context_api_service/app/governed/stage_driver.py`
  — the existing detection at ~line 259.

Tests:
- `tests/test_governed_stage_driver.py` (new or extend existing) —
  three scenarios: real loop refused-tool repetition trips at 3;
  exploring with distinct read_file calls does NOT trip; same
  read_file twice DOES trip (no novelty).

Risks: under-tightening (threshold too generous → real loops burn
more turns before halting). Mitigation: keep the cap at 3 not 4, and
the novelty exception is binary not graded.

### Phase 1 exit criteria

- A stage that produces `EditReceipt` automatically gets a real
  verifier run before VERIFY proceeds.
- A stage that plans 3 files and only edits 1 without explicit skip
  refuses advance past ACT.
- `VerificationReceipt(status="passed", commands_run=[])` is rejected
  at the model boundary.
- A 3-turn legitimate exploration sequence (3 distinct file reads)
  does not trip the stagnant detector.
- Full test suite still passes; container restart healthy.

---

## Phase 2 — Quality-aware eval

**Effort**: ~1 week. **Risk reduction**: high (eliminates the silent
capability-shift class).

### 2A — Enable `llm_judge` with stage-typed rubric  (~2 days)

`evaluator-factory.ts` currently returns "llm_judge is disabled in the
MVP evaluator runner" at line 315. The infrastructure (llm-gateway
client from audit-gov) already exists per the diagnose path. The
work is:

1. Implement the llm_judge case in the factory — POST to llm-gateway
   with the rubric + expected/actual outputs, parse a numeric score
   + reason, threshold-compare against `eval_config.judge_threshold`.

2. Author per-stage-type rubric in `StagePolicy.verificationPolicy`:
   - DEVELOPER: "Compiles cleanly + tests added or absence justified +
     diff is minimal + acceptance criteria addressed. 1-5 with reason."
   - QA: "Test plan addresses each acceptance criterion + edge cases
     identified + verification commands runnable. 1-5 with reason."
   - ARCHITECT: "Design addresses every stated requirement + risks
     enumerated + alternatives considered. 1-5 with reason."

3. Add a `judge_evidence_paths: list[str]` field on the receipt so the
   rubric can require specific artifacts to be present.

Files:
- `audit-governance-service/src/eval/evaluator-factory.ts` line 315
- `audit-governance-service/src/eval/rubrics/` (new) — per-stage
  rubric text + threshold defaults
- `agent-and-tools/apps/prompt-composer/prisma/seed.ts` — extend
  StagePolicy.verificationPolicy with rubric reference

Tests:
- `audit-governance-service/test/eval/llm-judge.test.ts` (new) — mock
  llm-gateway response; happy path scores 5/5; below-threshold scores
  block; malformed judge response falls back to "manual review" not
  silent pass.

Risks:
- Rubric drift: rubrics that worked initially produce inconsistent
  scores after model upgrades. Mitigation: log the rubric version
  with each judgment; alert when score variance per rubric exceeds
  threshold.
- Cost: every gate run is +1 LLM call. Mitigation: judge model defaults
  to cheaper tier (e.g. gpt-4o-mini equivalent); only escalate on
  borderline scores.

### 2B — Wire eval failures back into next attempt  (~2 days)

When `EvalGate` blocks, the failing `engine_dataset_examples` rows +
the llm_judge reason field become part of the next attempt's prompt
context. The shape:

```
BlueprintSession.metadata.eval_feedback = {
  attempt_n_minus_1: {
    eval_id: "...",
    evaluator_kind: "llm_judge",
    score: 2,
    reason: "Diff doesn't handle null input to validateEmail; case is in test suite but not addressed.",
    failing_examples: [{ trace_id, expected, actual }]
  }
}
```

This metadata flows into the next stage attempt's `vars` and gets
formatted as a synthetic system message:

> Previous attempt was blocked by quality gate. Judge feedback: ...
> Failing example: ...

Files:
- `workgraph-studio/apps/api/src/modules/blueprint/blueprint.router.ts`
  — `executeRequest` reads eval_feedback from metadata and threads it
  into ExecuteRequest.vars.
- `audit-governance-service/src/eval/eval-gate-executor.ts` — on
  block, persist the structured feedback to BlueprintSession.metadata.
- `context-fabric/services/context_api_service/app/governed/loop.py`
  — `_build_messages` reads vars.eval_feedback and prepends the
  synthetic system message when present.

Tests:
- End-to-end test in audit-governance-service that simulates an
  eval block → retry → confirms the retry's first LLM call includes
  the feedback in its prompt.

Risks:
- Feedback poisoning: a bad rubric / bad judgment shapes future
  agent behavior. Mitigation: operator can clear eval_feedback from
  metadata; rubric versions are tracked so we can A/B.
- Prompt bloat: feedback adds tokens to every retry. Mitigation:
  cap feedback length to ~500 tokens; only include the most recent
  attempt's feedback, not the chain.

### 2C — Operator curation gate  (~2 days)

`engine_dataset_examples` gains a `reviewed_at: timestamp` column.
`expected_output` is treated as "candidate" until reviewed. EvalGate
refuses to gate on un-reviewed examples by default; a config flag
lets an operator opt in to gating-on-raw.

Files:
- `audit-governance-service/prisma/schema.prisma` — new column +
  migration.
- `audit-governance-service/web/src/...` — UI flow: list candidate
  examples, edit `expected_output`, mark reviewed.
- `audit-governance-service/src/eval/eval-gate-executor.ts` — refuse
  un-reviewed by default; respect `allow_unreviewed: true` config.

Tests: existing eval-gate tests need the `reviewed_at` setup; one
new test for "un-reviewed example refuses to gate."

Risks: low. Mostly UI work.

### Phase 2 exit criteria

- `evaluator-factory.ts` line 315 no longer reads "MVP disabled."
- A new stage type can opt into `llm_judge` by adding a rubric ref.
- An EvalGate-blocked retry sees the structured judge feedback in
  its first LLM call's prompt.
- Datasets built from raw traces do not gate by default.

---

## Phase 3 — Long-context correctness

**Effort**: 2-3 days. **Risk reduction**: medium.

### 3A — History compression in stage_driver  (~1.5 days)

Sliding window for the last N turns kept verbatim; older turns
compressed via breadcrumb summarisation. Port invoke.ts's
`applySlidingWindow` (line 3685+) and `buildBreadcrumbMessage`
to Python in `stage_driver.py`.

Window size driven by `StagePolicy.limits.history_recent_turns`
(default 8). Older turns compressed to one line each:
`"Turn N (PHASE): called {tool1, tool2}, EditReceipt covering a.py"`.

Files:
- `context-fabric/services/context_api_service/app/governed/stage_driver.py`
  — `_history_from_turn` becomes one half; new
  `_compressed_history_from_stage` handles the other.
- `context-fabric/services/context_api_service/app/governed/history_compression.py`
  (new) — pure functions, easy to test.

Tests:
- Snapshot test: a 25-turn stage history is compressed to a known
  shape (8 recent verbatim + 17 breadcrumbs).
- Round-trip test: compressed history still references all distinct
  tool_invocation_ids that produced receipts.

Risks: information loss in breadcrumbs. Mitigation: receipts produced
by older turns stay verbatim in `PhaseState.receipts`; only the
LLM-facing message log compresses.

### 3B — Prompt-injection delimiters  (~half day)

Wrap tool outputs in delimiters that signal "this is data, not
instruction." Per-provider format:
- Anthropic: `<tool_result>...</tool_result>` XML tags.
- OpenAI: structured content array.
- Mock: plain (no special handling).

Files:
- `context-fabric/services/context_api_service/app/governed/turn.py`
  — `_build_messages` wraps tool result content.

Tests:
- Confirm tool outputs are wrapped per provider.
- Confirm a tool output that itself contains the delimiter string is
  escaped (otherwise a prompt-injection can close the tag and inject
  instructions).

Risks: provider-specific token waste. Mitigation: delimiters are
short.

### Phase 3 exit criteria

- A 25-turn stage's LLM prompt size is bounded by `history_recent_turns
  × avg_turn_size + N × breadcrumb_size`, not by total turn count.
- Tool outputs cannot inject instructions that the LLM interprets as
  system-level (verified by test fixture).

---

## Phase 4 — Capability harness (offline, separate workstream)

**Effort**: 1 week initial + ongoing maintenance.

### 4A — SWE-bench-lite offline runner  (~5 days)

Picks a fixed corpus (20-50 tasks initially, modeled on
SWE-bench-Lite), runs each through `governed_step` with all
production policy in effect, scores by:
- Tests pass (the SWE-bench style oracle)
- Diff matches reference within some tolerance
- LLM-judge of fix quality on each task

Lives outside the production code path entirely — own runner script,
own results store, own dashboard. Weekly cron runs all models in the
production fleet against the corpus; flags any regression > 5%.

Files:
- `tools/capability-harness/` (new top-level directory)
  - `runner.py` — corpus loader + governed_step driver
  - `scoring.py` — three-oracle scoring
  - `corpora/swe-lite-50.json` — initial task definitions
  - `dashboards/` — Grafana panels or just markdown reports

Risks:
- Corpus quality: a bad corpus measures the wrong things. Mitigation:
  start with SWE-bench-Lite tasks since they're already curated.
- Cost: 50 tasks × ~50 turns × 5 models = $50-100/week. Acceptable
  for the signal.

### 4B — Cadence + reporting  (~2 days)

Weekly cron, results posted to audit-gov, regression alerts via the
existing audit-gov SSE channel. Per-model dashboard tab.

### Phase 4 exit criteria

- Weekly automated run with results stored.
- Per-model pass-rate trend visible to operators.
- Regression alert fires when any model's score drops > 5% week-over-week.

---

## Cross-cutting decisions

These are decisions that need to be made BEFORE phases start, not
discovered during implementation.

1. **Auto-verify on REPAIR too?** Recommend yes. Same risk profile as
   ACT.

2. **Judge model default tier?** Recommend gpt-4o-mini-equivalent
   ("haiku" tier) for cost. Escalate to opus tier only when the score
   is borderline (2.5-3.5 on a 1-5 scale).

3. **Rubric authoring: per-stage-type or per-capability?** Recommend
   per-stage-type initially (DEVELOPER/QA/ARCHITECT/SECURITY/DEVOPS).
   Per-capability is the long-term right answer but it's a research
   problem (rubric drift across capability_id boundaries). Stage-type
   is good enough to start.

4. **Feedback length cap in closed loop?** Recommend ~500 tokens of
   structured feedback; full failing examples linked by trace_id, not
   inlined.

5. **Capability harness corpus refresh cadence?** Recommend quarterly
   review of the 50 tasks. Add 10 new ones each quarter, retire 10
   that no longer discriminate between models.

---

## Effort summary

| Phase | Effort | Critical-path? |
|-------|--------|----------------|
| 1A auto-verify on mutation | 1.5 days | Yes |
| 1B path-coverage check | 3 hours | No |
| 1C VerificationReceipt validator | 1 hour | No |
| 1D stagnant-phase fix | 2 hours | No |
| 2A llm_judge + rubric | 2 days | Yes (blocks 2B) |
| 2B closed-loop wiring | 2 days | Yes (depends on 2A) |
| 2C operator curation gate | 2 days | No |
| 3A history compression | 1.5 days | No |
| 3B injection delimiters | 0.5 day | No |
| 4A capability harness | 5 days | Independent |
| 4B cadence + reporting | 2 days | Independent |
| **Total critical path** | **~7.5 days** | (1A → 2A → 2B) |
| **Total all phases** | **~20 days** | If sequential |

Parallelisable: 1B/1C/1D can run with 1A. 2C can run with 2A/2B. 3A/3B
can run with anything. Phase 4 is fully independent.

With one person, sequential: ~4 weeks. With two people parallelising
on the critical path: ~2.5 weeks.

---

## Out of scope for this plan

Tracked elsewhere, intentionally not blending into this work:

- **Task #93** — multi-turn PII mask implementation. Separate design
  doc at `context-fabric/docs/M73-pii-regression.md`.
- **Task #92** — MCP_BEARER_TOKEN rotation. Design-first; separate
  workstream.
- **Task #90** — applier-model decision. Blocked on Phase 4 (need
  capability data to decide).

---

## Risks not specific to any single phase

- **Reviewer fatigue on Phase 2C** — operators won't curate
  expected_output if the UI flow is painful. Mitigation: make the
  default reviewed state "approved" with one click; only diverging
  edits require typing.
- **Phase 1A increases stage latency** — each ACT-with-edits now has
  one extra synchronous tool call. Mitigation: monitor p95 stage
  duration before/after; if regression > 20%, gate the auto-verify
  behind a policy flag (default on) so capabilities can opt out.
- **Phase 2A judge cost spikes** — bad rubric causes every gate to
  request escalation. Mitigation: cost alert at $X/day; rubric-tier
  fallback to substring match if judge unavailable.

---

## Where to start

If picking a single "do next" slice that maximises risk reduction per
unit of work, given Phase 1 items are now down to invoke-parity work:

**Recommend: 1B + 1C + 1D in one sitting** (~6 hours total). These are
the cheap structural fixes that close concrete loopholes without
needing any cross-service coordination. They land bit-for-bit
verifiable behaviour change. After that, 1A is the next single
biggest impact item.
