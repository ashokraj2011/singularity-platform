"""M96.3 — unit tests for the orchestrator salvage path + cumulative
per-phase validation-error counter.

Repro being guarded (develop attempt 3f8db8d7, WRK-DCA8D): the agent made
correct edits (confirmed code_change_id provenance) but burned its budget
in ACT producing invalid EditReceipts, never converged, the stage failed
VALIDATION_BLOCKED, and the correct work was DISCARDED.

Two mechanisms close that failure class:

  • M96.1 salvage — when a mutating phase (ACT/REPAIR) is about to halt
    FAILED but `produced_code_changes` carries real provenance, the
    orchestrator synthesizes the EditReceipt the agent should have
    submitted, runs the REAL verifier (never fabricated), and routes
    forward. A passing verifier opens the HUMAN approval gate
    (APPROVAL_PENDING); a failing/unavailable verifier stays in VERIFY
    with a distinct stop_reason that still maps to FAILED downstream.

  • M96.2 cumulative counter — the consecutive counter resets on any
    non-validation step, so it's blind to the alternating
    bad-receipt→tool-call→bad-receipt pattern. A per-phase cumulative
    counter that only resets on phase advance catches it.

Conventions (match the rest of context-fabric/tests/): no pytest-asyncio,
drive coroutines with asyncio.run() inline; patch against the importing
module's namespace (stage_driver imports synthesize_verifier_run +
emit_governed_event, so we patch THOSE names on stage_driver).
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import patch

from context_api_service.app.governed.loop import GovernedStepResult, ToolCallOutcome
from context_api_service.app.governed.phase_state import Phase, PhaseState
from context_api_service.app.governed.policy_loader import PolicyNotFoundError
from context_api_service.app.governed.receipts import (
    EditReceipt,
    SelfReviewReceipt,
    VerificationReceipt,
)
from context_api_service.app.governed import stage_driver
from context_api_service.app.governed.stage_driver import (
    StageRunResult,
    _salvage_mutating_phase,
    _salvageable_changed_paths,
    _synthesize_edit_receipt,
    _synthesize_self_review_receipt,
    _synthesize_verification_receipt,
    _synthetic_verifier_turn,
    run_stage,
)
from context_api_service.app.governed.turn import TurnResult
from context_api_service.app.governed.verify_synthesis import SyntheticVerifierResult


# ── fixtures / builders ──────────────────────────────────────────────────────


def _act_state(**overrides: Any) -> PhaseState:
    """A PhaseState parked in ACT with one confirmed code change, i.e. the
    exact shape the salvage path is meant to recover."""
    defaults: dict[str, Any] = dict(
        stage_key="develop",
        agent_role="DEVELOPER",
        current_phase=Phase.ACT,
        produced_code_changes={"src/main/java/Foo.java": ["cc-1"]},
    )
    defaults.update(overrides)
    return PhaseState(**defaults)


def _ran(passed: bool) -> SyntheticVerifierResult:
    return SyntheticVerifierResult(
        kind="ran",
        command="mvn -q test",
        exit_code=0 if passed else 1,
        duration_ms=4200,
        stdout_summary="Tests run: 12, Failures: 0" if passed else "Tests run: 12, Failures: 3",
        stderr_summary="" if passed else "AssertionError",
        tool_success=passed,
        tool_invocation_id="ti-verify-1",
    )


def _unavailable() -> SyntheticVerifierResult:
    return SyntheticVerifierResult(
        kind="unavailable",
        reason="verifier-registry returned no candidates for changed paths",
    )


def _run_salvage(result: StageRunResult, state: PhaseState, synth: SyntheticVerifierResult) -> bool:
    """Invoke the async salvage with synthesize_verifier_run + emit stubbed."""

    async def _fake_synth(*_a: Any, **_k: Any) -> SyntheticVerifierResult:
        return synth

    async def _fake_emit(*_a: Any, **_k: Any) -> None:
        return None

    async def _go() -> bool:
        with patch(
            "context_api_service.app.governed.stage_driver.synthesize_verifier_run",
            new=_fake_synth,
        ), patch(
            "context_api_service.app.governed.stage_driver.emit_governed_event",
            new=_fake_emit,
        ):
            return await _salvage_mutating_phase(
                result,
                state,
                stage_policy=None,
                run_context={"work_item_id": "WRK-DCA8D", "workspace_id": "ws-1"},
                bearer="tok",
                turn_idx=29,
                trigger="validation_blocked",
            )

    return asyncio.run(_go())


# ── pure helpers: _salvageable_changed_paths ─────────────────────────────────


def test_salvageable_paths_keeps_bound_change_ids():
    state = _act_state(
        produced_code_changes={
            "src/A.java": ["cc-1", "cc-2"],
            "  src/B.java  ": ["cc-3"],  # whitespace stripped
        }
    )
    assert sorted(_salvageable_changed_paths(state)) == ["src/A.java", "src/B.java"]


def test_salvageable_paths_drops_unbacked_and_empty():
    state = _act_state(
        produced_code_changes={
            "src/A.java": [],          # no provenance → dropped
            "": ["cc-9"],              # empty path → dropped
            "   ": ["cc-10"],          # whitespace-only path → dropped
            "src/Real.java": ["cc-1"], # kept
        }
    )
    assert _salvageable_changed_paths(state) == ["src/Real.java"]


def test_salvageable_paths_empty_when_no_changes():
    assert _salvageable_changed_paths(_act_state(produced_code_changes={})) == []


# ── pure helpers: synthesized receipts validate through real Pydantic models ──


def test_synthesized_edit_receipt_is_validator_clean():
    paths = ["src/A.java", "src/B.java"]
    receipt = EditReceipt(**_synthesize_edit_receipt(paths))
    assert receipt.kind.value == "edit_receipt"
    assert [e.file for e in receipt.edits] == paths
    assert all(e.edit_type == "apply_patch" for e in receipt.edits)
    # salvaged marker is preserved (extra="allow")
    assert getattr(receipt, "salvaged", None) is True


def test_synthesized_verification_receipt_passed():
    r = VerificationReceipt(**_synthesize_verification_receipt(_ran(passed=True)))
    vr = r.verification_result
    assert vr.status == "passed"
    assert len(vr.commands_run) == 1
    # passed ⇒ every command exit_code == 0 (validator would 400 otherwise)
    assert all(c.exit_code == 0 for c in vr.commands_run)


def test_synthesized_verification_receipt_failed():
    r = VerificationReceipt(**_synthesize_verification_receipt(_ran(passed=False)))
    vr = r.verification_result
    assert vr.status == "failed"
    assert len(vr.commands_run) == 1
    assert vr.commands_run[0].exit_code != 0


def test_synthesized_verification_receipt_unavailable_has_reason():
    r = VerificationReceipt(**_synthesize_verification_receipt(_unavailable()))
    vr = r.verification_result
    assert vr.status == "unavailable"
    assert vr.commands_run == []
    # validator requires a non-empty reason for unavailable
    assert vr.reason and vr.reason.strip()


def test_synthesized_self_review_passed_recommends_approval():
    r = SelfReviewReceipt(**_synthesize_self_review_receipt(passed=True, paths=["src/A.java"]))
    assert r.recommended_for_approval is True
    assert r.diff_summary.files_changed == ["src/A.java"]
    assert getattr(r, "salvaged", None) is True


def test_synthesized_self_review_failed_does_not_recommend():
    r = SelfReviewReceipt(**_synthesize_self_review_receipt(passed=False, paths=["src/A.java"]))
    assert r.recommended_for_approval is False


# ── pure helpers: synthetic verifier turn shape (workgraph-api harvest) ───────


def test_synthetic_verifier_turn_passed_shape():
    turn = _synthetic_verifier_turn(_ran(passed=True), from_phase="VERIFY", turn_idx=30)
    assert turn["to_phase"] == Phase.VERIFY.value
    assert turn["phase_advanced"] is True
    assert turn["salvaged"] is True
    [outcome] = turn["tool_outcomes"]
    # harvested by orchestrator.ts on tool_name=='run_test' OR kind=='verification_result'
    assert outcome["tool_name"] == "run_test"
    assert outcome["tool_success"] is True
    env = outcome["result"]
    assert env["kind"] == "verification_result"
    assert env["passed"] is True
    assert env["exit_code"] == 0
    assert env["unavailable"] is False
    assert env["salvaged"] is True and env["synthetic"] is True
    assert env["id"] == "ti-verify-1"


def test_synthetic_verifier_turn_unavailable_shape():
    turn = _synthetic_verifier_turn(_unavailable(), from_phase="VERIFY", turn_idx=30)
    [outcome] = turn["tool_outcomes"]
    assert outcome["tool_success"] is False
    env = outcome["result"]
    assert env["passed"] is False
    assert env["unavailable"] is True
    assert env["reason"]  # carries the unavailable reason


# ── async: _salvage_mutating_phase ────────────────────────────────────────────


def test_salvage_noop_when_phase_not_mutating():
    state = _act_state(current_phase=Phase.EXPLORE)
    result = StageRunResult(final_state=state)
    assert _run_salvage(result, state, _ran(passed=True)) is False
    assert result.stop_reason == ""  # caller's original halt left intact


def test_salvage_noop_when_no_observed_changes():
    state = _act_state(produced_code_changes={})
    result = StageRunResult(final_state=state)
    assert _run_salvage(result, state, _ran(passed=True)) is False
    assert result.stop_reason == ""


def test_salvage_passed_opens_approval_gate():
    state = _act_state()
    result = StageRunResult(final_state=state)

    fired = _run_salvage(result, state, _ran(passed=True))

    assert fired is True
    assert result.stop_reason == "APPROVAL_PENDING"
    # never auto-finalize — the HUMAN gate must still open
    assert result.final_state.current_phase is Phase.SELF_REVIEW
    assert result.final_state.approval_pending is True
    # a synthetic verifier turn was recorded for the harvest path
    assert result.total_tool_calls == 1
    assert any(t.get("salvaged") for t in result.turns)
    # the EDIT + VERIFICATION + SELF_REVIEW receipts are persisted on state
    assert "edit_receipt" in _kinds(result.final_state)
    assert "verification_receipt" in _kinds(result.final_state)
    assert "self_review_receipt" in _kinds(result.final_state)


def test_salvage_verify_failed_stays_verify_and_maps_to_failed():
    state = _act_state()
    result = StageRunResult(final_state=state)

    fired = _run_salvage(result, state, _ran(passed=False))

    assert fired is True
    assert result.stop_reason == "SALVAGED_VERIFY_FAILED"
    # stays in VERIFY — must NOT masquerade as a clean pass
    assert result.final_state.current_phase is Phase.VERIFY
    assert result.final_state.approval_pending is False
    assert "verification_receipt" in _kinds(result.final_state)


def test_salvage_verify_unavailable_stays_verify():
    state = _act_state()
    result = StageRunResult(final_state=state)

    fired = _run_salvage(result, state, _unavailable())

    assert fired is True
    assert result.stop_reason == "SALVAGED_VERIFY_UNAVAILABLE"
    assert result.final_state.current_phase is Phase.VERIFY
    assert result.final_state.approval_pending is False


def test_salvage_works_from_repair_phase():
    state = _act_state(current_phase=Phase.REPAIR)
    result = StageRunResult(final_state=state)

    fired = _run_salvage(result, state, _ran(passed=True))

    assert fired is True
    assert result.stop_reason == "APPROVAL_PENDING"
    assert result.final_state.current_phase is Phase.SELF_REVIEW


def _kinds(state: PhaseState) -> set[str]:
    """All receipt kinds persisted across every phase bucket on the state."""
    out: set[str] = set()
    for receipts in (state.receipts or {}).values():
        for r in receipts:
            k = r.get("kind") if isinstance(r, dict) else None
            if k:
                out.add(k)
    return out


# ── M96.2 — cumulative per-phase validation counter (run_stage integration) ───
#
# These drive the REAL run_stage loop with a scripted run_turn so the
# counter wiring (increment / reset-on-advance / salvage-first-then-halt) is
# exercised end-to-end, not just the helper functions.


def _phase(name: str) -> PhaseState:
    """A fresh PhaseState parked in `name` with NO observed code changes — so
    salvage bows out (returns False) and we test the COUNTER, not the salvage."""
    return PhaseState(
        stage_key="develop",
        agent_role="DEVELOPER",
        current_phase=Phase[name],
        produced_code_changes={},  # empty ⇒ _salvage_mutating_phase returns False
    )


def _validation_turn(phase: str) -> TurnResult:
    """A turn that submitted an invalid receipt: no advance, validation_error
    set, no tool calls. This is the 'bad receipt' half of the alternating
    pattern the consecutive counter is blind to."""
    state = _phase(phase)
    step = GovernedStepResult(
        next_state=state,
        from_phase=phase,
        to_phase=phase,
        phase_advanced=False,
        tool_outcomes=[],
        validation_error={
            "phase": phase,
            "reason": "EditReceipt.edits min_length=1 not satisfied",
            "details": [{"loc": "edits", "issue": "list too short"}],
        },
    )
    return TurnResult(next_state=state, step=step, llm={}, prompt={}, policy={})


def _progress_turn(phase: str, n: int) -> TurnResult:
    """A turn that dispatched a NOVEL read (resets the consecutive counter and
    the stagnant counter), no advance, no validation error. This is the
    intervening 'tool call' that isolates each validation error and defeats
    the consecutive budget."""
    state = _phase(phase)
    outcome = ToolCallOutcome(
        tool_name="read_file",
        phase=phase,
        allowed=True,
        args={"path": f"src/F{n}.java"},
        result={"content": f"// file {n}"},
        tool_success=True,
        tool_invocation_id=f"ti-read-{n}",
    )
    step = GovernedStepResult(
        next_state=state,
        from_phase=phase,
        to_phase=phase,
        phase_advanced=False,
        tool_outcomes=[outcome],
        validation_error=None,
    )
    return TurnResult(next_state=state, step=step, llm={}, prompt={}, policy={})


def _advance_turn(from_phase: str, to_phase: str, *, approval: bool = False) -> TurnResult:
    """A turn that advances the phase. When approval=True the next_state lands
    in SELF_REVIEW with approval_pending — the loop halts APPROVAL_PENDING."""
    next_state = PhaseState(
        stage_key="develop",
        agent_role="DEVELOPER",
        current_phase=Phase[to_phase],
        approval_pending=approval,
        produced_code_changes={},
    )
    step = GovernedStepResult(
        next_state=next_state,
        from_phase=from_phase,
        to_phase=to_phase,
        phase_advanced=True,
        tool_outcomes=[],
        validation_error=None,
    )
    return TurnResult(next_state=next_state, step=step, llm={}, prompt={}, policy={})


def _drive(script: list[TurnResult], *, start: PhaseState, max_turns: int = 25) -> StageRunResult:
    """Run the REAL run_stage with run_turn scripted from `script`, all
    network/IO stubbed out. Each call to run_turn pops the next scripted turn."""
    seq = iter(script)

    async def _fake_run_turn(**_kw: Any) -> TurnResult:
        return next(seq)

    async def _fake_emit(*_a: Any, **_k: Any) -> None:
        return None

    async def _no_policy(*_a: Any, **_k: Any):
        raise PolicyNotFoundError("no policy in test")

    async def _no_salvage_verifier(*_a: Any, **_k: Any) -> SyntheticVerifierResult:
        # Defensive: empty produced_code_changes means salvage never reaches
        # here, but stub it so nothing escapes to the network if that changes.
        return SyntheticVerifierResult(kind="unavailable", reason="stubbed in test")

    async def _go() -> StageRunResult:
        with patch.object(stage_driver, "run_turn", new=_fake_run_turn), patch.object(
            stage_driver, "emit_governed_event", new=_fake_emit
        ), patch.object(stage_driver, "load_stage_policy", new=_no_policy), patch.object(
            stage_driver, "synthesize_verifier_run", new=_no_salvage_verifier
        ):
            return await run_stage(
                state=start,
                stage_key="develop",
                agent_role="DEVELOPER",
                max_turns=max_turns,
            )

    return asyncio.run(_go())


def test_cumulative_counter_trips_on_alternating_pattern():
    """The 3f8db8d7 repro: bad-receipt → read → bad-receipt → read … . The
    CONSECUTIVE counter never exceeds 1 (each validation is isolated by a
    read), so the old guard would let this run to MAX_TURNS. The cumulative
    per-phase counter (budget 4) trips on the 5th ACT validation error."""
    # 5 validation errors interleaved with 4 progress reads, all in ACT.
    script = [
        _validation_turn("ACT"),   # cumulative ACT = 1, consecutive = 1
        _progress_turn("ACT", 0),  # consecutive → 0  (cumulative stays 1)
        _validation_turn("ACT"),   # cumulative = 2
        _progress_turn("ACT", 1),
        _validation_turn("ACT"),   # cumulative = 3
        _progress_turn("ACT", 2),
        _validation_turn("ACT"),   # cumulative = 4  (== budget, survives)
        _progress_turn("ACT", 3),
        _validation_turn("ACT"),   # cumulative = 5  > budget → TRIP
    ]
    result = _drive(script, start=_phase("ACT"))

    assert result.stop_reason == "VALIDATION_BLOCKED"
    # Halted at the 9th turn (index 8) — long before MAX_TURNS=25. Proof the
    # cumulative counter fired, since consecutive never reached its budget.
    assert len(result.turns) == 9
    assert result.final_state.current_phase is Phase.ACT


def test_consecutive_budget_alone_would_not_trip_this_pattern():
    """Sanity anchor: only 4 cumulative ACT validation errors (one under the
    budget), still alternating so consecutive never exceeds 1. The stage must
    NOT halt VALIDATION_BLOCKED — it runs to MAX_TURNS."""
    script = [
        _validation_turn("ACT"),
        _progress_turn("ACT", 0),
        _validation_turn("ACT"),
        _progress_turn("ACT", 1),
        _validation_turn("ACT"),
        _progress_turn("ACT", 2),
        _validation_turn("ACT"),   # cumulative = 4 (not > 4)
        _progress_turn("ACT", 3),
    ] + [_progress_turn("ACT", 100 + i) for i in range(25)]  # pad to MAX_TURNS
    result = _drive(script, start=_phase("ACT"), max_turns=12)

    assert result.stop_reason == "MAX_TURNS"
    assert result.stop_reason != "VALIDATION_BLOCKED"


def test_cumulative_counter_resets_on_phase_advance():
    """4 cumulative ACT validation errors (survives), then advance to VERIFY
    and on to an approved SELF_REVIEW. The reset-on-advance clears ACT's
    churn so the stage reaches APPROVAL_PENDING instead of VALIDATION_BLOCKED."""
    script = [
        _validation_turn("ACT"),
        _progress_turn("ACT", 0),
        _validation_turn("ACT"),
        _progress_turn("ACT", 1),
        _validation_turn("ACT"),
        _progress_turn("ACT", 2),
        _validation_turn("ACT"),          # cumulative ACT = 4 (survives)
        _advance_turn("ACT", "VERIFY"),   # resets validation_errors_in_phase[ACT]
        _advance_turn("VERIFY", "SELF_REVIEW", approval=True),  # → APPROVAL_PENDING
    ]
    result = _drive(script, start=_phase("ACT"))

    assert result.stop_reason == "APPROVAL_PENDING"
    assert result.final_state.current_phase is Phase.SELF_REVIEW
    assert result.final_state.approval_pending is True
