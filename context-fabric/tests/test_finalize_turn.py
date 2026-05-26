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


def test_finalize_without_receipt_is_not_terminal():
    """Just entering FINALIZE must NOT terminate the loop — the agent
    still needs a turn to call finish_work_branch and submit the
    FinalizeReceipt."""
    state = _state_at_finalize()
    assert state.current_phase is Phase.FINALIZE
    assert _is_terminal_state(state) is False, (
        "loop must continue so the agent gets a turn in FINALIZE; "
        "exiting here strands the work uncommitted on disk"
    )


def test_finalize_with_receipt_is_terminal():
    """Once the agent has actually submitted a FinalizeReceipt (i.e.
    called finish_work_branch and reported the resulting
    branch_name/commit_sha), the loop exits."""
    state = _state_at_finalize()
    # Simulate the agent's FINALIZE turn submitting its receipt.
    state = advance_phase(
        state,
        Phase.FINALIZE,
        receipt={
            "kind": "finalize_artifact",
            "branch_name": "sg/WRK-123/develop/1-abc",
            "commit_sha": "a1b2c3d4",
        },
    )
    assert _is_terminal_state(state) is True


def test_non_finalize_phase_is_not_terminal():
    """Trivially, no other phase should look terminal."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    assert _is_terminal_state(state) is False
    state = advance_phase(state, Phase.EXPLORE)
    assert _is_terminal_state(state) is False
    state = advance_phase(state, Phase.ACT)
    assert _is_terminal_state(state) is False


def test_finalize_terminal_check_ignores_other_phase_receipts():
    """A receipt in EXPLORE/ACT/VERIFY/SELF_REVIEW doesn't satisfy the
    FINALIZE bucket check — only FINALIZE receipts count."""
    state = _state_at_finalize()
    # state has receipts in EXPLORE/ACT/VERIFY/SELF_REVIEW buckets
    # (from the advance_phase calls above), but no FINALIZE bucket yet.
    assert state.receipts.get(Phase.SELF_REVIEW.value), (
        "test setup invariant: SELF_REVIEW bucket should have the receipt"
    )
    assert state.receipts.get(Phase.FINALIZE.value) is None
    assert _is_terminal_state(state) is False
