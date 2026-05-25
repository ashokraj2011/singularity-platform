"""
Task #84 — Eval harness for `governed_step`.

The existing `tests/test_governed_loop.py` covers a handful of behaviour
cases but isn't shaped as a scenario catalogue you can extend by adding
a row. This file is.

Each row in SCENARIOS exercises one end-to-end behaviour through
`governed_step` with:
  * a starting PhaseState (auto-walked to the requested phase)
  * a StagePolicy with the per-phase allowlist you specify
  * canned LLM tool_calls + phase_output (no real LLM)
  * a canned ToolDispatchResult for each successful dispatch
  * a set of assertions over the returned GovernedStepResult

Adding coverage is as easy as appending a dict to SCENARIOS. CI runs the
whole catalogue every commit. Because every external seam
(emit_governed_event, dispatch_tool) is monkeypatched here exactly the
same way the existing tests do it, the harness needs zero infra to run
— no mcp-server, no audit-gov, no LLM gateway.

The same scaffolding can later host:
  * regression fixtures captured from real runs (just convert a
    GovernedStepResult into a row).
  * cost/latency budget assertions.
  * cross-version golden output diffs.

Today it ships with 7 scenarios covering the failure modes we hit
this milestone (M76 + M78).
"""
from __future__ import annotations

import pytest

from context_api_service.app.governed import (
    Phase,
    PhasePolicy,
    PhaseState,
    StagePolicy,
    ToolDispatchResult,
    governed_step,
)
from context_api_service.app.governed.phase_state import advance_phase


# ── helpers (same shape as tests/test_governed_loop.py) ────────────────────


def _policy(allowed_by_phase: dict[Phase, list[str]]) -> StagePolicy:
    phases: dict[Phase, PhasePolicy] = {}
    for phase, allowed in allowed_by_phase.items():
        phases[phase] = PhasePolicy(
            phase=phase,
            allowed_tools=frozenset(allowed),
            forbidden_tools=frozenset(),
            required_output_schema={},
            max_input_tokens=None,
            max_output_tokens=None,
            max_tool_calls=None,
        )
    return StagePolicy(
        policy_id="test-policy",
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        version=1,
        status="ACTIVE",
        approval_model={},
        limits={"max_repair_attempts": 3},
        context_policy={},
        edit_policy={},
        verification_policy={},
        risk_policy={},
        phases=phases,
    )


def _fresh_state(phase: Phase = Phase.PLAN) -> PhaseState:
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    next_map = {
        Phase.PLAN: Phase.EXPLORE,
        Phase.EXPLORE: Phase.ACT,
        Phase.ACT: Phase.VERIFY,
        Phase.VERIFY: Phase.SELF_REVIEW,
        Phase.SELF_REVIEW: Phase.FINALIZE,
    }
    while state.current_phase is not phase:
        state = advance_phase(state, next_map[state.current_phase])
    return state


@pytest.fixture(autouse=True)
def _silence_audit(monkeypatch):
    async def _noop(**_kwargs):
        return None
    monkeypatch.setattr(
        "context_api_service.app.governed.loop.emit_governed_event", _noop
    )


# ── scenario catalogue ─────────────────────────────────────────────────────
#
# Each entry is a dict with the following keys. All except `name` and
# `initial_phase` are optional — omit what you don't need.
#
#   name              str   — pytest id, shown on failure
#   initial_phase     Phase — where the state starts
#   allowed_tools     dict  — { Phase: [tool_name, ...] } phase allowlist
#   tool_calls        list  — what the LLM "emits" this turn
#   tool_results      dict  — { tool_name: ToolDispatchResult } for dispatch mocking
#   phase_output      dict  — receipt payload submitted with the turn (None → skip)
#   next_phase        Phase — phase to advance to (None → no advance)
#   expect_advance    bool  — assertion: did phase_advanced come back True?
#   expect_to_phase   Phase — assertion: result.to_phase value
#   expect_outcomes_n int   — assertion: tool_outcomes length
#   expect_allowed    list  — assertion: which outcomes (by index) should be allowed=True
#   expect_validation bool  — assertion: validation_error is set (True) or unset (False)


def _ok(result: dict) -> ToolDispatchResult:
    """Shorthand for a successful dispatch result."""
    return ToolDispatchResult(
        result=result,
        duration_ms=10,
        tool_invocation_id=f"ti-{id(result) % 100000}",
        tool_success=True,
        tool_error=None,
    )


SCENARIOS: list[dict] = [
    # ── 1. Happy path: allowed tool dispatches cleanly ─────────────────
    {
        "name": "PLAN: allowed repo_map dispatches",
        "initial_phase": Phase.PLAN,
        "allowed_tools": {Phase.PLAN: ["repo_map"]},
        "tool_calls": [{"tool_name": "repo_map", "args": {"path": "."}}],
        "tool_results": {"repo_map": _ok({"branches": ["main"]})},
        "expect_outcomes_n": 1,
        "expect_allowed": [0],
        "expect_advance": False,
    },
    # ── 2. Tool refused: not in allowlist, no dispatch, captured outcome ──
    {
        "name": "PLAN: forbidden apply_patch refused (wrong phase)",
        "initial_phase": Phase.PLAN,
        "allowed_tools": {Phase.PLAN: ["repo_map"]},
        "tool_calls": [
            {"tool_name": "apply_patch", "args": {"path": "x.py", "patch": "..."}},
        ],
        "tool_results": {},  # dispatch should not be called
        "expect_outcomes_n": 1,
        "expect_allowed": [],  # the only outcome should be refused
        "expect_advance": False,
    },
    # ── 3. Mix: one allowed + one refused in the same turn ─────────────
    {
        "name": "PLAN: mixed allowed/refused dispatch in one turn",
        "initial_phase": Phase.PLAN,
        "allowed_tools": {Phase.PLAN: ["repo_map"]},
        "tool_calls": [
            {"tool_name": "repo_map", "args": {}},
            {"tool_name": "apply_patch", "args": {"patch": "..."}},
        ],
        "tool_results": {"repo_map": _ok({"branches": ["main"]})},
        "expect_outcomes_n": 2,
        "expect_allowed": [0],
        "expect_advance": False,
    },
    # ── 4. Phase output valid → advance + receipt persisted ─────────────
    {
        "name": "PLAN→EXPLORE: valid PlanReceipt advances",
        "initial_phase": Phase.PLAN,
        "allowed_tools": {
            Phase.PLAN: ["repo_map"],
            Phase.EXPLORE: ["repo_map"],
        },
        "phase_output": {
            "target_files": ["src/main.py"],
            "test_strategy": {"commands": ["pytest"]},
            "risk_level": "low",
            "scope_summary": "Implement function X",
            "dependency_notes": "none",
        },
        "next_phase": Phase.EXPLORE,
        "expect_advance": True,
        "expect_to_phase": Phase.EXPLORE,
        "expect_validation": False,
    },
    # ── 5. Phase output INVALID → no advance + validation_error set ────
    # PlanReceipt requires target_files + test_strategy; missing them fires
    # PHASE_OUTPUT_INVALID without advancing. This is the validator path
    # that caught the schema drift in M78 Slice 1 prep.
    {
        "name": "PLAN→EXPLORE: missing target_files → validation_error",
        "initial_phase": Phase.PLAN,
        "allowed_tools": {
            Phase.PLAN: ["repo_map"],
            Phase.EXPLORE: ["repo_map"],
        },
        "phase_output": {
            # Deliberately missing target_files + test_strategy
            "risk_level": "low",
        },
        "next_phase": Phase.EXPLORE,
        "expect_advance": False,
        "expect_validation": True,
    },
    # ── 6. Cross-phase: tool allowed in current phase but agent emits
    # tool from a different phase → refused (per M71 hard-refuse mode) ──
    {
        "name": "ACT: emitting EXPLORE-only tool refused at ACT",
        "initial_phase": Phase.ACT,
        "allowed_tools": {
            Phase.EXPLORE: ["find_symbol"],
            Phase.ACT: ["apply_patch"],
        },
        "tool_calls": [
            {"tool_name": "find_symbol", "args": {"symbol": "X"}},
        ],
        "tool_results": {},
        "expect_outcomes_n": 1,
        "expect_allowed": [],
        "expect_advance": False,
    },
    # ── 7. ACT→VERIFY: mutating tool tracked + receipt advances ────────
    {
        "name": "ACT→VERIFY: apply_patch tracked + EditReceipt advances",
        "initial_phase": Phase.ACT,
        "allowed_tools": {
            Phase.ACT: ["apply_patch"],
            Phase.VERIFY: ["run_test"],
        },
        "tool_calls": [
            {"tool_name": "apply_patch", "args": {"path": "src/x.py", "patch": "..."}},
        ],
        "tool_results": {
            "apply_patch": ToolDispatchResult(
                result={
                    "kind": "code_change",
                    "paths_touched": ["src/x.py"],
                    "diff": "...",
                    "patch": "...",
                    "lines_added": 1,
                    "lines_removed": 0,
                },
                duration_ms=15,
                tool_invocation_id="ti-act-001",
                tool_success=True,
                tool_error=None,
            ),
        },
        "phase_output": {
            "edits": [
                {"file": "src/x.py", "edit_type": "apply_patch", "reason": "fix bug"},
            ],
            "skipped_targets": [],
        },
        "next_phase": Phase.VERIFY,
        "expect_outcomes_n": 1,
        "expect_allowed": [0],
        "expect_advance": True,
        "expect_to_phase": Phase.VERIFY,
        "expect_validation": False,
    },
]


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s["name"])
@pytest.mark.asyncio
async def test_governed_step_scenario(scenario, monkeypatch):
    """Drives one scenario through governed_step + asserts the outcomes
    declared in the scenario dict. Add coverage by appending to
    SCENARIOS — no other code changes needed."""
    policy = _policy(scenario.get("allowed_tools", {Phase.PLAN: []}))
    state = _fresh_state(scenario["initial_phase"])

    # Mock dispatch_tool to consult the scenario's tool_results table.
    # When the tool_name isn't there, the test crashes loudly — that's
    # the right failure mode: it means the scenario forgot to declare
    # what the tool should return.
    tool_results: dict = scenario.get("tool_results", {})
    dispatched: list[str] = []

    async def fake_dispatch(*, tool_name, args, **_kwargs):
        dispatched.append(tool_name)
        if tool_name not in tool_results:
            raise AssertionError(
                f"scenario {scenario['name']!r}: dispatch called for "
                f"tool {tool_name!r} but no tool_results entry. "
                f"Declared: {sorted(tool_results.keys())}"
            )
        return tool_results[tool_name]

    monkeypatch.setattr(
        "context_api_service.app.governed.loop.dispatch_tool", fake_dispatch
    )

    result = await governed_step(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        tool_calls=scenario.get("tool_calls"),
        phase_output=scenario.get("phase_output"),
        next_phase=scenario.get("next_phase"),
        policy=policy,
    )

    # ── assertions ──
    if "expect_outcomes_n" in scenario:
        assert len(result.tool_outcomes) == scenario["expect_outcomes_n"], (
            f"expected {scenario['expect_outcomes_n']} outcomes, got "
            f"{[o.tool_name for o in result.tool_outcomes]}"
        )
    if "expect_allowed" in scenario:
        allowed_idxs = [i for i, o in enumerate(result.tool_outcomes) if o.allowed]
        assert allowed_idxs == scenario["expect_allowed"], (
            f"expected allowed indices {scenario['expect_allowed']}, got "
            f"{allowed_idxs}"
        )
    if "expect_advance" in scenario:
        assert result.phase_advanced is scenario["expect_advance"], (
            f"expected phase_advanced={scenario['expect_advance']}, got "
            f"{result.phase_advanced} (validation_error={result.validation_error})"
        )
    if "expect_to_phase" in scenario:
        assert result.to_phase == scenario["expect_to_phase"], (
            f"expected to_phase={scenario['expect_to_phase']}, got "
            f"{result.to_phase}"
        )
    if "expect_validation" in scenario:
        has_error = result.validation_error is not None
        assert has_error is scenario["expect_validation"], (
            f"expected validation_error set={scenario['expect_validation']}, "
            f"got error={result.validation_error}"
        )


def test_scenario_catalogue_grows_smoothly():
    """Trivial guard that prevents accidentally dropping all scenarios in
    a refactor. If you legitimately remove every scenario, bump this
    threshold to 0 (and consider why you're keeping this harness at all)."""
    assert len(SCENARIOS) >= 5, (
        f"the eval scenario catalogue dropped below 5 cases "
        f"(have {len(SCENARIOS)}). If intentional, lower this guard."
    )
