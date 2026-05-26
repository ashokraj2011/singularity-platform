"""FINALIZE phase must give the agent at least one turn.

Repro 2026-05-26 session ef0e849e: dev attempts 22b07b16, c119c6b7,
51e2d192, 2aac14dc, 186a5c9b, abbc8251 all reached FINALIZE phase
but the loop exited immediately on the SELF_REVIEW→FINALIZE
transition, before the agent could call finish_work_branch. The
work was committed to disk in the worktree but never persisted
on a branch, so downstream stages (security-review, qa-review)
opened fresh worktrees from main and reported "no diff".

The fix: _is_terminal_state requires BOTH current_phase=FINALIZE
AND at least one receipt in the FINALIZE bucket — i.e. the agent
took a turn in FINALIZE, called finish_work_branch, and submitted
the FinalizeReceipt. Until that's true, the loop keeps going.
"""
from __future__ import annotations

from context_api_service.app.governed.phase_state import (
    Phase,
    PhaseState,
    advance_phase,
)
from context_api_service.app.governed.stage_driver import _is_terminal_state


def _state_at_finalize() -> PhaseState:
    """Build a state representative of the agent having just submitted a
    SelfReviewReceipt with next_phase=FINALIZE — phase machine advances,
    but no FinalizeReceipt has been produced yet."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    state = advance_phase(state, Phase.EXPLORE)
    state = advance_phase(state, Phase.ACT)
    state = advance_phase(state, Phase.VERIFY)
    state = advance_phase(
        state, Phase.SELF_REVIEW, receipt={"kind": "verification_receipt"}
    )
    state = advance_phase(
        state,
        Phase.FINALIZE,
        receipt={"kind": "self_review_receipt", "recommended_for_approval": True},
    )
    return state


def test_entering_finalize_is_terminal():
    """Reaching FINALIZE terminates the loop. The earlier "require a
    FinalizeReceipt in the bucket before terminating" variant caused
    infinite-loop-until-MAX_TURNS in practice — the agent kept
    burning turns in FINALIZE without ever calling
    finish_work_branch (repro session 5f95ad4b dev attempt 68195c30,
    56 LLM calls, zero finish_work_branch dispatches).

    The architectural answer: the dev SELF_REVIEW prompt now requires
    calling finish_work_branch in the SAME turn as submit_phase_output,
    so the commit lands BEFORE the phase advances. _is_terminal_state
    can stay simple."""
    state = _state_at_finalize()
    assert state.current_phase is Phase.FINALIZE
    assert _is_terminal_state(state) is True


def test_non_finalize_phase_is_not_terminal():
    """Trivially, no other phase should look terminal."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    assert _is_terminal_state(state) is False
    state = advance_phase(state, Phase.EXPLORE)
    assert _is_terminal_state(state) is False
    state = advance_phase(state, Phase.ACT)
    assert _is_terminal_state(state) is False
