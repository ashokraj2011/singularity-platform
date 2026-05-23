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


def test_can_transition_plan_directly_to_self_review():
    """task #112 — non-coding stages (PRODUCT_OWNER, ARCHITECT) have a
    2-phase policy: PLAN + SELF_REVIEW only. Their tool allowlists are
    empty / read-only and they have no EXPLORE/ACT/VERIFY phases
    defined, so the only way they can finish is by jumping straight
    from PLAN to SELF_REVIEW. Coding stages still use the canonical
    PLAN→EXPLORE→ACT→VERIFY→SELF_REVIEW path because their prompts
    drive there; the new edge is additive.

    Skipping VERIFY would be wrong for coding stages where mutations
    happened — but for non-coding stages there's nothing to verify.
    The policy + prompt are what steer; the phase machine just
    permits the transition.
    """
    assert can_transition(Phase.PLAN, Phase.SELF_REVIEW) is True


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


# ── plan-rewind cap (M73-followup #5) ───────────────────────────────────────


def test_advance_phase_caps_plan_rewinds():
    """EXPLORE → PLAN re-routes must stop at max_plan_rewinds. The default
    (2) lets the agent reroute twice (3 total PLANs across the run) before
    being forced to commit to ACT. Past that, ValueError."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    # initial PLAN → EXPLORE (does NOT count as a rewind)
    state = advance_phase(state, Phase.EXPLORE)
    assert state.plan_rewinds == 0

    # 1st rewind
    state = advance_phase(state, Phase.PLAN, max_plan_rewinds=2)
    assert state.plan_rewinds == 1
    state = advance_phase(state, Phase.EXPLORE, max_plan_rewinds=2)

    # 2nd rewind — still allowed
    state = advance_phase(state, Phase.PLAN, max_plan_rewinds=2)
    assert state.plan_rewinds == 2
    state = advance_phase(state, Phase.EXPLORE, max_plan_rewinds=2)

    # 3rd rewind — refused. The agent has to commit to ACT (or anything
    # other than PLAN) from here.
    with pytest.raises(ValueError, match="plan_rewinds would exceed"):
        advance_phase(state, Phase.PLAN, max_plan_rewinds=2)


def test_advance_phase_plan_to_plan_does_not_count_as_rewind():
    """PLAN → PLAN (re-plan on same phase if output invalid) is a different
    transition from EXPLORE → PLAN. The cap only fires on the latter."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    # PLAN → PLAN three times — wouldn't be allowed if the cap counted this.
    state = advance_phase(state, Phase.PLAN, max_plan_rewinds=0)
    state = advance_phase(state, Phase.PLAN, max_plan_rewinds=0)
    state = advance_phase(state, Phase.PLAN, max_plan_rewinds=0)
    assert state.plan_rewinds == 0  # never incremented


def test_advance_phase_zero_plan_rewinds_means_no_reroute_allowed():
    """Edge case: a policy that sets max_plan_rewinds=0 forces the agent
    to commit on its first PLAN. The first EXPLORE → PLAN must refuse."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    state = advance_phase(state, Phase.EXPLORE)
    with pytest.raises(ValueError, match="plan_rewinds would exceed"):
        advance_phase(state, Phase.PLAN, max_plan_rewinds=0)


def test_plan_rewinds_round_trips_through_to_from_dict():
    """plan_rewinds must survive BlueprintSession.metadata persistence."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    state = advance_phase(state, Phase.EXPLORE)
    state = advance_phase(state, Phase.PLAN, max_plan_rewinds=2)
    payload = state.to_dict()
    assert payload["plan_rewinds"] == 1
    rehydrated = PhaseState.from_dict(payload)
    assert rehydrated.plan_rewinds == 1


def test_plan_rewinds_from_dict_defaults_zero_for_legacy_state():
    """Pre-M73-followup state rows didn't have plan_rewinds. The from_dict
    rehydrate must default to 0 rather than KeyError."""
    legacy_payload = {
        "stage_key": "loop.stage",
        "agent_role": "DEVELOPER",
        "current_phase": "EXPLORE",
        "repair_attempts": 0,
        # plan_rewinds missing
        "receipts": {},
        "history": [],
        "approval_pending": False,
    }
    state = PhaseState.from_dict(legacy_payload)
    assert state.plan_rewinds == 0


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
