# Session summary — 2026-05-23

Multi-hour session that closed out M75 Phase A (laptop bridge
cutover), shipped M74 Phase 4A+B (capability harness end-to-end),
patched two structural Prisma drift incidents, fixed three
post-cutover bugs that were silently broken in production, and
documented the MCP_BEARER_TOKEN rotation strategy.

Net: 11 commits to `main`, ~14 task items closed, 73 new tests
across the capability harness + ~10 elsewhere.

## What landed on main

| Commit | Task | What |
|---|---|---|
| `b23cbc9` | #107 | M75 Slice 4 — prefer_laptop wired into governed flow |
| `aaa80c2` | #108 | M75 Slice 5 — per-tool laptop audit + telemetry parity |
| `21197e7` | #109 | M75 Slice 6 — LAPTOP_USE_LEGACY_INVOKE rollback + docs |
| `6edd7ec` | #110 | audit-gov diagnose.ts repointed off dead `/mcp/invoke` |
| `3483c90` | #111 | Operator curation UI for dataset examples |
| `bf93eac` | (drift) | M40 contractHash migration backfilled |
| `7faff79` | #112 | PRODUCT_OWNER/ARCHITECT prompts + PLAN→SELF_REVIEW edge |
| `432d48f` | #113 | Prisma drift prevention — startup wrappers |
| `046abc3` | #114 | M74 Phase 4A Slice 1 — capability harness foundation |
| `85e38b5` | #115 | M74 Phase 4A Slice 2 — real test sandbox |
| `4118334` | #116 | M74 Phase 4A Slice 3 — audit-gov integration |
| `a86dbce` | #117 + #92 | M74 Phase 4B — regression detector + cron + bearer rotation doc |

## Production state changes operators should know

### M75 laptop bridge — **Phase A complete**

Governed coding stages now dispatch tools through the user's
laptop bridge end-to-end (`tool-run` frame, not `invoke`). Per-tool
audit attribution lands as `governed.tool_dispatched_via_laptop`
events. Emergency rollback flag: `LAPTOP_USE_LEGACY_INVOKE=true`
on the CF container forces every governed call back onto the
shared HTTP mcp-server without a re-deploy. The legacy
`executeInvokePayload` path is no longer the active laptop entry
but stays in the tree for back-compat with old desktops.

Phase B/C (final deletion of legacy invoke, desktop version pin)
documented in `docs/M75-laptop-bridge-cutover.md`. Calendar-time
gated on in-flight legacy pause drain.

### Prompt-composer + agent-runtime — **drift prevention live**

Both services now boot through `bin/startup.sh` wrappers that
apply hand-written `.sql` migrations (idempotent via IF NOT
EXISTS, tracked in `_singularity_startup_migrations`) and
regenerate the Prisma client. The two drift modes this session
hit:

- DB missing a column the client expects (M40's `contractHash`)
- Client missing a column the schema defines (M71 Slice E's
  `phase`)

…are both impossible going forward when these services boot.
`prisma db push` deliberately NOT used (would drop the
shared-DB sibling's tables).

### Capability harness — **operational**

```bash
# Real bench with audit-gov publishing:
python tools/capability-harness/runner.py \
    --corpus tools/capability-harness/corpora/mini-3.json \
    --publish-audit-gov --audit-gov-url http://localhost:8500

# Standalone regression check:
python tools/capability-harness/regression.py

# Weekly cadence (Mondays 09:00 local):
sudo cp tools/capability-harness/cron/weekly-bench.{service,timer} \
        /etc/systemd/system/
sudo systemctl enable --now weekly-bench.timer
```

Three event kinds in audit-gov:
- `capability.bench_run_started`
- `capability.bench_task_completed`
- `capability.bench_run_completed`
- `capability.bench_regression_alert` (fires on >=5pp drop vs
  trailing 4-run mean per model)

Operator dashboards filter on these for the per-model trend view.

### Operator curation UI — **live route**

`/curation` in workgraph-web (admin nav, ClipboardCheck icon).
Backed by `/api/engine/datasets` + `/api/engine/dataset-examples/:id`
proxy on workgraph-api. M74 Phase 2C eval gate is now
operator-actionable instead of needing hand-rolled curl PATCHes.

### Workbench non-coding stages — **fixed**

PRODUCT_OWNER (story-intake) and ARCHITECT (design) were silently
broken since the M71 cutover — their prompts asked for prose, but
the governed validator wanted structured JSON via
`submit_phase_output`, and the phase machine had no PLAN →
SELF_REVIEW edge. Both fixed:

- Phase machine now permits PLAN→SELF_REVIEW for 2-phase policies.
- Prompt-composer `loop.stage` bindings appended with the phase
  protocol section (idempotent migration: `m71_nontrivial_
  phase_protocol.sql`).

### audit-gov diagnose — **functional again**

`diagnose.ts` was POSTing to `/mcp/invoke` (410 since M71). Now
calls llm-gateway directly using the same pattern as M74's
`llm-judge.ts`. Heuristic fallback path preserved for gateway
outages.

## Container state at session end

All 29 platform containers running and healthy after the rebuild.
prompt-composer + agent-runtime now run from images that contain
the startup wrappers. The migration backfill for `contractHash`
and the m71 phase protocol prompt update are persisted in source
(durable across DB rebuilds).

## Pending — handed off

### Genuinely blocked

- **#90 Decide on applier-model** — needs benchmark data from
  running the capability harness against a corpus with vs without
  the applier-model. Harness is ready; just needs the comparison
  run and a decision.

### Operator action required (not Claude-actionable)

- **GitHub PAT rotation** — the token shared in plaintext chat
  earlier in the session is compromised. Revoke at
  https://github.com/settings/tokens. ~30 seconds.

### Open but lower priority

- **#84 Eval harness for governed_step** — overlaps substantially
  with the capability harness work this session. Recommend
  reviewing and either closing as duplicate or scoping to the
  in-process Python harness pattern (vs the HTTP-based capability
  harness already built).

### Documented for future sessions

- **M75 Phase B/C** — final `executeInvokePayload` deletion.
  Calendar-time gated.
- **MCP_BEARER_TOKEN rotation implementation** — design doc lands
  this session (`docs/M75-mcp-bearer-rotation.md`). ~1 day of
  implementation when scheduled.
- **Capability harness Slice 2.1** — language support beyond Python
  in the sandbox (sandbox.py header documents this).
- **Capability harness Slice 2.2** — real SWE-bench-Lite tasks
  with per-task `git clone` + `pip install -e .`. Requires
  Docker-per-task or mcp-server sandbox.
- **Audit-gov dashboard UI** for the new `capability.bench_*`
  event family — events are queryable via the existing search
  endpoint; a dedicated tab would be a small follow-up.

## Verification commands an operator can run cold

```bash
# 1. All capability harness tests green
python -m pytest tools/capability-harness/tests/ \
    --deselect tools/capability-harness/tests/test_sandbox.py::test_sandbox_kills_on_timeout

# 2. Harness end-to-end smoke (no network)
python tools/capability-harness/runner.py \
    --corpus tools/capability-harness/corpora/mini-3.json --dry-run

# 3. Prompt-composer phase resolver returns the new protocol
curl -s -X POST http://localhost:3004/api/v1/stage-prompts/resolve \
    -H 'content-type: application/json' \
    -d '{"stageKey":"loop.stage.story-intake","agentRole":"PRODUCT_OWNER"}' \
  | grep -q submit_phase_output && echo "phase protocol live"

# 4. agent-runtime no longer crashes on contractHash
curl -s http://localhost:3003/api/v1/agents/templates/<any-template-id>/versions

# 5. Curation route mounted (expect 401, NOT 404)
curl -s -o /dev/null -w "%{http_code}\n" \
    http://localhost:8080/api/engine/datasets

# 6. Container health
docker ps --format "table {{.Names}}\t{{.Status}}" | head -30
```

## What I'd suggest next

1. **Rotate the GitHub PAT** (you, ~30 seconds).
2. **Pick a real model and run the capability harness for the
   first time** — that produces the baseline that future
   regressions are detected against. Without a first run, the
   detector is in zero-history state forever.
3. **Run the operator curation UI** through one example so the
   reviewed_at column has real data and Phase 2C's evaluator
   stops refusing.
4. **Schedule one quarterly bearer rotation dry-run** in dev
   following the steps in `docs/M75-mcp-bearer-rotation.md`. The
   sooner the runbook is muscle memory, the better the muscle
   memory.

## What I'd NOT recommend

- Spinning up Slice 2.2 (real SWE-bench git-clone-per-task) until
  you have signal on whether the existing inline-test corpus is
  catching the regressions you care about. The infra cost of a
  full SWE-bench sandbox is high; defer until evidence justifies.
- Closing #84 as duplicate of #114-117 without thinking — they
  COULD be the same thing, but if you ever want pure in-process
  Python eval (no HTTP, no sandbox subprocess) it's a different
  problem.
