"""
M71 — Phase state machine unit tests.

Covers every transition in `_ALLOWED_TRANSITIONS`, plus the illegal-transition
refusals and the repair-cap enforcement.
"""
import pytest

from context_api_service.app.governed.phase_state import (
    PHASE_ORDER,
    Phase,
    PhaseState,
    advance_phase,
    can_transition,
)


# ── happy-path forward walk ─────────────────────────────────────────────────


def test_phase_order_constant():
    """PHASE_ORDER must list all 7 phases in canonical order."""
    assert PHASE_ORDER == (
        Phase.PLAN,
        Phase.EXPLORE,
        Phase.ACT,
        Phase.VERIFY,
        Phase.REPAIR,
        Phase.SELF_REVIEW,
        Phase.FINALIZE,
    )


@pytest.mark.parametrize(
    "from_phase,to_phase",
    [
        (Phase.PLAN, Phase.EXPLORE),
        (Phase.EXPLORE, Phase.ACT),
        (Phase.ACT, Phase.VERIFY),
        (Phase.VERIFY, Phase.SELF_REVIEW),
        (Phase.SELF_REVIEW, Phase.FINALIZE),
    ],
)
def test_can_transition_happy_path(from_phase: Phase, to_phase: Phase):
    """The canonical PLAN → EXPLORE → ACT → VERIFY → SELF_REVIEW → FINALIZE
    path must be allowed."""
    assert can_transition(from_phase, to_phase) is True


@pytest.mark.parametrize(
    "from_phase,to_phase",
    [
        (Phase.VERIFY, Phase.REPAIR),
        (Phase.REPAIR, Phase.VERIFY),
        (Phase.SELF_REVIEW, Phase.REPAIR),  # human asks for changes
        (Phase.EXPLORE, Phase.PLAN),         # scope error
    ],
)
def test_can_transition_repair_edges(from_phase: Phase, to_phase: Phase):
    """Repair + backwards-edges that the spec explicitly allows."""
    assert can_transition(from_phase, to_phase) is True


# ── illegal transitions ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "from_phase,to_phase",
    [
        (Phase.PLAN, Phase.ACT),           # skipping EXPLORE
        (Phase.PLAN, Phase.VERIFY),        # skipping EXPLORE+ACT
        (Phase.ACT, Phase.SELF_REVIEW),    # skipping VERIFY — the spec's main gate
        (Phase.ACT, Phase.FINALIZE),       # skipping everything
        (Phase.PLAN, Phase.FINALIZE),      # nope
        (Phase.VERIFY, Phase.FINALIZE),    # missing SELF_REVIEW
        (Phase.FINALIZE, Phase.PLAN),      # FINALIZE is terminal
        (Phase.FINALIZE, Phase.REPAIR),
    ],
)
def test_can_transition_illegal_skips(from_phase: Phase, to_phase: Phase):
    """Skipping VERIFY, FINALIZE-then-anything, and other illegal jumps."""
    assert can_transition(from_phase, to_phase) is False


def test_advance_phase_refuses_illegal():
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    with pytest.raises(ValueError, match="Illegal phase transition"):
        advance_phase(state, Phase.ACT)  # PLAN → ACT is forbidden


# ── repair cap ──────────────────────────────────────────────────────────────


def test_advance_phase_caps_repair_attempts():
    """Repair must stop at max_repair_attempts. Past that, ValueError."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    state = advance_phase(state, Phase.EXPLORE)
    state = advance_phase(state, Phase.ACT)
    state = advance_phase(state, Phase.VERIFY)
    for attempt in range(1, 4):  # 3 repairs is the policy default
        state = advance_phase(state, Phase.REPAIR, max_repair_attempts=3)
        assert state.repair_attempts == attempt
        state = advance_phase(state, Phase.VERIFY)
    # 4th repair must be refused.
    with pytest.raises(ValueError, match="repair_attempts would exceed"):
        advance_phase(state, Phase.REPAIR, max_repair_attempts=3)


# ── receipt persistence + approval flag ─────────────────────────────────────


def test_advance_phase_records_receipt_and_history():
    """Receipts are bucketed by the phase that PRODUCED them; history tracks
    every transition with timestamps."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    plan_receipt = {"kind": "plan_receipt", "target_files": ["a.py"]}
    state = advance_phase(state, Phase.EXPLORE, receipt=plan_receipt)
    assert state.current_phase is Phase.EXPLORE
    assert state.receipts["PLAN"] == [plan_receipt]
    assert len(state.history) == 1
    assert state.history[0]["from"] == "PLAN"
    assert state.history[0]["to"] == "EXPLORE"
    assert "at" in state.history[0]


def test_advance_phase_sets_approval_pending_on_self_review_recommend():
    """SELF_REVIEW with recommended_for_approval=True flips the flag that
    workgraph-api uses to open the approval gate."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    state = advance_phase(state, Phase.EXPLORE)
    state = advance_phase(state, Phase.ACT)
    state = advance_phase(state, Phase.VERIFY)
    state = advance_phase(
        state, Phase.SELF_REVIEW, receipt={"kind": "self_review_receipt", "recommended_for_approval": True}
    )
    assert state.approval_pending is True


def test_advance_phase_self_review_no_recommend_keeps_flag_false():
    """A self-review that does NOT recommend approval must not open the gate."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    state = advance_phase(state, Phase.EXPLORE)
    state = advance_phase(state, Phase.ACT)
    state = advance_phase(state, Phase.VERIFY)
    state = advance_phase(
        state, Phase.SELF_REVIEW, receipt={"kind": "self_review_receipt", "recommended_for_approval": False}
    )
    assert state.approval_pending is False


# ── serialization round-trip ────────────────────────────────────────────────


def test_phase_state_to_from_dict_roundtrip():
    """Phase state must survive a JSON round-trip without losing fidelity —
    BlueprintSession.metadata stores it that way."""
    original = PhaseState.fresh("loop.stage", "DEVELOPER")
    original = advance_phase(original, Phase.EXPLORE, receipt={"kind": "plan_receipt"})
    payload = original.to_dict()
    rehydrated = PhaseState.from_dict(payload)
    assert rehydrated == original


def test_phase_state_frozen():
    """Direct mutation must fail — state advances only via advance_phase()."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    with pytest.raises(Exception):
        state.current_phase = Phase.ACT  # type: ignore[misc]
