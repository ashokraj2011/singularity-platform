"""Phase 3 — governed resume parity.

apply_approval_decision() maps a human approval-gate decision onto the phase
machine for a stage paused at APPROVAL_PENDING (SELF_REVIEW + approval_pending):
  approved → FINALIZE (loop then runs finish_work_branch), rejected → REPAIR.
Unchanged when not paused, decision unrecognised, or transition illegal.
"""
from context_api_service.app.governed.phase_state import (
    Phase,
    PhaseState,
    apply_approval_decision,
)


def _paused(repair_attempts: int = 0) -> PhaseState:
    return PhaseState.from_dict({
        "stage_key": "develop",
        "agent_role": "DEVELOPER",
        "current_phase": "SELF_REVIEW",
        "repair_attempts": repair_attempts,
        "plan_rewinds": 0,
        "receipts": {},
        "history": [],
        "approval_pending": True,
        "pii_token_map": {},
        "produced_code_changes": {},
    })


def test_approved_drives_self_review_to_finalize():
    out = apply_approval_decision(_paused(), "approved")
    assert out.current_phase is Phase.FINALIZE
    assert out.approval_pending is False  # gate cleared on advance


def test_approved_aliases():
    for d in ("approve", "accept", "ACCEPTED", " Approved "):
        assert apply_approval_decision(_paused(), d).current_phase is Phase.FINALIZE


def test_rejected_drives_self_review_to_repair():
    out = apply_approval_decision(_paused(), "rejected")
    assert out.current_phase is Phase.REPAIR
    assert out.repair_attempts == 1  # advance_phase bumps the repair counter


def test_changes_requested_alias():
    assert apply_approval_decision(_paused(), "changes_requested").current_phase is Phase.REPAIR


def test_unknown_decision_is_noop():
    s = _paused()
    out = apply_approval_decision(s, "maybe")
    assert out is s and out.current_phase is Phase.SELF_REVIEW


def test_not_paused_is_noop():
    # approval_pending False ⇒ no gate to act on, even at SELF_REVIEW.
    s = PhaseState.from_dict({
        "stage_key": "develop", "agent_role": "DEVELOPER", "current_phase": "SELF_REVIEW",
        "repair_attempts": 0, "plan_rewinds": 0, "receipts": {}, "history": [],
        "approval_pending": False, "pii_token_map": {}, "produced_code_changes": {},
    })
    assert apply_approval_decision(s, "approved") is s


def test_repair_cap_exhausted_leaves_state_paused():
    # repair_attempts at the cap (3) ⇒ SELF_REVIEW→REPAIR is refused; stay paused.
    s = _paused(repair_attempts=3)
    out = apply_approval_decision(s, "rejected")
    assert out.current_phase is Phase.SELF_REVIEW and out.approval_pending is True


def test_run_stage_paused_entry_short_circuits_without_a_turn(monkeypatch):
    # P2 — a stage entered already at the approval gate (e.g. a rejected resume
    # whose REPAIR cap is exhausted, leaving the state unchanged) must re-surface
    # APPROVAL_PENDING WITHOUT spending an LLM turn.
    import asyncio
    from context_api_service.app.governed import stage_driver

    calls = {"run_turn": 0}

    async def _boom(*a, **k):
        calls["run_turn"] += 1
        raise AssertionError("run_turn must not run for a paused entry")

    monkeypatch.setattr(stage_driver, "run_turn", _boom)
    result = asyncio.new_event_loop().run_until_complete(
        stage_driver.run_stage(state=_paused(repair_attempts=3), stage_key="loop.stage", agent_role="DEVELOPER")
    )
    assert result.stop_reason == "APPROVAL_PENDING"
    assert calls["run_turn"] == 0
