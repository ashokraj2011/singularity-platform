"""Narrate-without-act bounce — render-message tests.

Covers `_render_narrate_without_act_message`. The bounce is invoked
from `run_stage` after a turn produces no tool outcomes and no
validation_error in a mutating phase (ACT / REPAIR). This file pins
the rendered message shape; the loop-level integration is exercised
by the governed-loop suite.

Repro that motivated the bounce: develop attempt 5b7c069c-… on
2026-05-26, where the agent entered REPAIR after a failing VERIFY,
emitted narrative text ("I need to move to REPAIR phase since
there's a test failure that needs to be fixed. Let me submit the
VERIFY phase output indicating failure, then move to REPAIR.") and
never called submit_phase_output. The stage ran out of turn budget
and finalised as FAILED in 13 seconds.
"""
from __future__ import annotations

from context_api_service.app.governed.phase_state import Phase, PhaseState
from context_api_service.app.governed.stage_driver import (
    _render_narrate_without_act_message,
)


def _state(phase: Phase) -> PhaseState:
    return PhaseState(
        current_phase=phase,
        stage_key="develop",
        agent_role="DEVELOPER",
    )


def test_render_includes_current_phase_name():
    msg = _render_narrate_without_act_message(_state(Phase.REPAIR))
    assert msg["role"] == "user"
    assert "REPAIR" in msg["content"]


def test_render_names_submit_phase_output():
    msg = _render_narrate_without_act_message(_state(Phase.ACT))
    # The bounce must mention both escape hatches so the LLM knows what
    # to do next: call a tool OR submit the receipt.
    assert "submit_phase_output" in msg["content"]
    assert "tool" in msg["content"].lower()


def test_render_flags_text_only_as_the_problem():
    msg = _render_narrate_without_act_message(_state(Phase.REPAIR))
    # The tag matters — operators search the prompt history for these
    # tags to debug stuck attempts.
    assert "[NARRATE-WITHOUT-ACT]" in msg["content"]


def test_render_is_phase_specific_text():
    # Same render function in different phases should reflect the
    # caller's phase string, not a hard-coded literal.
    act_msg = _render_narrate_without_act_message(_state(Phase.ACT))
    repair_msg = _render_narrate_without_act_message(_state(Phase.REPAIR))
    assert "ACT" in act_msg["content"]
    assert "REPAIR" in repair_msg["content"]
    assert act_msg["content"] != repair_msg["content"]


# ── M83.y P3 — read-then-narrate variant ──────────────────────────────────


def test_read_only_variant_explicitly_calls_out_the_pattern():
    """The 'read-only' variant message must tell the model the
    specific failure: 'you read files and wrote prose but didn't
    actually patch'. Generic empty-turn copy isn't enough — operators
    seeing this in audit-gov need to recognise the read-then-narrate
    fingerprint without diffing two prompt variants."""
    msg = _render_narrate_without_act_message(_state(Phase.REPAIR), variant="read-only")
    assert msg["role"] == "user"
    body = msg["content"]
    assert "[NARRATE-WITHOUT-ACT]" in body
    assert "read files" in body
    assert "REPAIR" in body
    # Must list mutation tools by name so the model has zero ambiguity
    # about what counts as acting.
    assert "apply_patch" in body
    # Must explicitly reject prose-only — the whole point of the bounce.
    assert "prose" in body.lower()


def test_empty_variant_default_unchanged():
    """Default variant (no kwarg) still produces the legacy empty-turn
    bounce body so M70.x's audit-gov searches keep matching."""
    msg = _render_narrate_without_act_message(_state(Phase.ACT))
    # The legacy body uses "text only" — the new variant uses "read files".
    assert "text only" in msg["content"]
    assert "read files" not in msg["content"]


# ── M83.y P3 — predicate ──────────────────────────────────────────────────


class _StubStep:
    """Minimal duck-type stand-in for GovernedStepResult."""
    def __init__(self, tool_outcomes=None, validation_error=None, phase_advanced=False):
        self.tool_outcomes = tool_outcomes or []
        self.validation_error = validation_error
        self.phase_advanced = phase_advanced


class _StubOutcome:
    def __init__(self, tool_name, allowed=True, tool_success=True):
        self.tool_name = tool_name
        self.allowed = allowed
        self.tool_success = tool_success


class _StubTurn:
    def __init__(self, step, llm_content=""):
        self.step = step
        self.llm = {"content": llm_content}


def test_predicate_returns_empty_variant_when_no_tool_calls():
    """No tool outcomes at all → original 'empty' bounce."""
    from context_api_service.app.governed.stage_driver import (
        _is_narrate_only_in_mutating_phase,
    )
    state = _state(Phase.REPAIR)
    turn = _StubTurn(_StubStep(tool_outcomes=[]), llm_content="I will fix this.")
    should_bounce, variant = _is_narrate_only_in_mutating_phase(state, turn)
    assert should_bounce is True
    assert variant == "empty"


def test_predicate_returns_read_only_variant_when_read_plus_prose():
    """The Map.of() screenshot scenario: read_file fires, then the
    model writes substantive prose ending in 'Let me fix this:' but
    never emits apply_patch. Bounce as 'read-only'."""
    from context_api_service.app.governed.stage_driver import (
        _is_narrate_only_in_mutating_phase,
    )
    state = _state(Phase.REPAIR)
    long_prose = (
        "Looking at the test failure output and the test file I just read, I "
        "can now diagnose the issue. Problem identified: lines 136 and 167 "
        "in the test file use Map.of() which rejects null values. Let me fix this:"
    )
    turn = _StubTurn(
        _StubStep(tool_outcomes=[_StubOutcome("read_file")]),
        llm_content=long_prose,
    )
    should_bounce, variant = _is_narrate_only_in_mutating_phase(state, turn)
    assert should_bounce is True
    assert variant == "read-only"


def test_predicate_passes_when_mutation_fired():
    """If apply_patch DID fire in the same turn — even alongside reads
    — the bounce must not fire. The model acted."""
    from context_api_service.app.governed.stage_driver import (
        _is_narrate_only_in_mutating_phase,
    )
    state = _state(Phase.REPAIR)
    turn = _StubTurn(
        _StubStep(tool_outcomes=[
            _StubOutcome("read_file"),
            _StubOutcome("apply_patch"),
        ]),
        llm_content="Diagnosed and patched.",
    )
    should_bounce, variant = _is_narrate_only_in_mutating_phase(state, turn)
    assert should_bounce is False
    assert variant == ""


def test_predicate_passes_in_read_only_phase():
    """EXPLORE phase legitimately reads + narrates. No bounce."""
    from context_api_service.app.governed.stage_driver import (
        _is_narrate_only_in_mutating_phase,
    )
    state = _state(Phase.EXPLORE)
    turn = _StubTurn(
        _StubStep(tool_outcomes=[_StubOutcome("read_file")]),
        llm_content="I'll review what's in the codebase before planning. " * 4,
    )
    should_bounce, _ = _is_narrate_only_in_mutating_phase(state, turn)
    assert should_bounce is False


def test_predicate_ignores_short_text_with_reads():
    """Below the 80-char prose threshold, we don't bounce on 'ok' or
    'reading more' — those are ambient comments, not the
    read-then-narrate failure pattern. The model gets another turn
    to actually act."""
    from context_api_service.app.governed.stage_driver import (
        _is_narrate_only_in_mutating_phase,
    )
    state = _state(Phase.ACT)
    turn = _StubTurn(
        _StubStep(tool_outcomes=[_StubOutcome("read_file")]),
        llm_content="ok",
    )
    should_bounce, _ = _is_narrate_only_in_mutating_phase(state, turn)
    assert should_bounce is False


def test_predicate_passes_when_validation_error_present():
    """If the validation-error path is going to fire (phase output
    submitted but invalid), don't double-bounce."""
    from context_api_service.app.governed.stage_driver import (
        _is_narrate_only_in_mutating_phase,
    )
    state = _state(Phase.REPAIR)
    turn = _StubTurn(
        _StubStep(
            tool_outcomes=[],
            validation_error={"error_code": "PHASE_OUTPUT_INVALID"},
        ),
        llm_content="A" * 200,
    )
    should_bounce, _ = _is_narrate_only_in_mutating_phase(state, turn)
    assert should_bounce is False
