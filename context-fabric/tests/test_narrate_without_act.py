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
