# Capability Harness (M74 Phase 4A)

Offline benchmark runner for the governed coding loop. Plays a fixed
corpus of bug-fix / small-feature tasks through context-fabric's
`/api/v1/execute-governed-stage` endpoint with all production policy
in effect, then scores each run via three oracles:

1. **`oracle_diff_matches_reference`** — textual comparison of the
   agent's produced patch vs. the gold reference, normalised for
   whitespace and order. Catches obvious correctness, misses semantic
   equivalence.
2. **`oracle_llm_judge`** — LLM-as-judge with a per-task rubric.
   Pattern lifted from M74 Phase 2A. Catches "the fix is functionally
   right but doesn't look like the reference."
3. **`oracle_tests_pass`** — runs the failing tests against the
   agent's output. **Slice 1 stub** — wires to a real sandbox in
   Slice 2 (task #115).

## Why a separate harness vs. extending audit-gov's eval system

The audit-gov evaluator runs against historical traces — it scores
what happened. The capability harness runs **new** problems through
the live agent — it scores what the agent CAN do. Same scoring
machinery (three oracles, audit-gov storage), different input.

The harness lives outside the production code path so a corpus bug
can never affect a live run.

## Quick start

```bash
# Dry-run (no LLM calls, exercise the scoring pipeline against the
# corpus's stored sample_response field if present):
python tools/capability-harness/runner.py \
    --corpus tools/capability-harness/corpora/mini-3.json \
    --dry-run

# Real run against a running CF (default: http://localhost:8000):
python tools/capability-harness/runner.py \
    --corpus tools/capability-harness/corpora/mini-3.json

# Single task:
python tools/capability-harness/runner.py \
    --corpus tools/capability-harness/corpora/mini-3.json \
    --task palindrome_function

# Override the model:
python tools/capability-harness/runner.py \
    --corpus tools/capability-harness/corpora/mini-3.json \
    --model-alias claude-sonnet-4-5
```

Results land in `tools/capability-harness/results/<timestamp>/`:
- `run.jsonl` — one row per task with all scores + raw response
- `summary.md` — human-readable summary (pass rate, slowest, costliest)

## Corpus format

Each task is a JSON object — see `corpora/schema.md` for the full
spec. Required fields:

```json
{
  "task_id": "palindrome_function",
  "goal": "Implement is_palindrome(s) -> bool, case-insensitive.",
  "stage_key": "loop.stage.develop",
  "agent_role": "DEVELOPER",
  "rubric": "Does the code correctly handle empty strings, single chars, mixed case, and non-alphanumeric chars?",
  "reference_patch": "def is_palindrome(s): ..."
}
```

Optional: `sample_response` (for dry-run), `model_alias`,
`max_turns`, `setup_files` (Slice 2).

## Roadmap

- **Slice 1 (this commit, #114)** — Foundation: corpus loader, three
  oracles (tests-pass stubbed), HTTP runner, results writer.
- **Slice 2 (#115)** — Real test sandbox: workspace per task, gold
  test execution, tests_pass oracle goes live.
- **Slice 3 (#116)** — Audit-gov integration: results posted as
  `capability.bench_run` events.
- **Slice 4 (#117, Phase 4B)** — Weekly cron + per-model dashboards
  + regression alerts.
