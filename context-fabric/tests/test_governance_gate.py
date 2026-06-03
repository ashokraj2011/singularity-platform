"""Pure-function tests for the governance enforcement gate (G4).

Run: PYTHONPATH=context-fabric:context-fabric/services:context-fabric/shared \
     pytest context-fabric/tests/test_governance_gate.py
"""
from context_api_service.app.governed.stage_driver import (
    _evaluate_governance_block, _satisfied_evidence_keys,
)


def test_advisory_overlay_never_blocks():
    overlay = {"effectiveMode": "ADVISORY",
               "requiredEvidence": [{"evidenceKey": "X", "mode": "ADVISORY"}],
               "blockingControls": []}
    assert _evaluate_governance_block(overlay, set(), set()) == []


def test_required_evidence_blocks_unless_satisfied_or_waived():
    overlay = {"effectiveMode": "REQUIRED",
               "requiredEvidence": [{"evidenceKey": "UNIT_TEST", "mode": "REQUIRED"}],
               "blockingControls": []}
    assert [b["controlKey"] for b in _evaluate_governance_block(overlay, set(), set())] == ["UNIT_TEST"]
    assert _evaluate_governance_block(overlay, {"UNIT_TEST"}, set()) == []   # satisfied
    assert _evaluate_governance_block(overlay, set(), {"UNIT_TEST"}) == []   # waived


def test_blocking_controls_block_unless_satisfied_or_waived():
    overlay = {"effectiveMode": "BLOCKING", "requiredEvidence": [],
               "blockingControls": [{"controlKey": "SEC_REVIEW", "reason": "sec"}]}
    out = _evaluate_governance_block(overlay, set(), set())
    assert out and out[0]["controlKey"] == "SEC_REVIEW" and out[0]["kind"] == "control"
    assert _evaluate_governance_block(overlay, set(), {"SEC_REVIEW"}) == []  # waived
    assert _evaluate_governance_block(overlay, {"SEC_REVIEW"}, set()) == []  # satisfied


def test_advisory_evidence_skipped_even_in_blocking_overlay():
    overlay = {"effectiveMode": "BLOCKING",
               "requiredEvidence": [{"evidenceKey": "OPT", "mode": "ADVISORY"}],
               "blockingControls": []}
    assert _evaluate_governance_block(overlay, set(), set()) == []


def test_evidence_mode_inherits_effective_mode_when_unset():
    # No per-evidence mode → inherits the overlay's effectiveMode (BLOCKING) → blocks.
    overlay = {"effectiveMode": "BLOCKING",
               "requiredEvidence": [{"evidenceKey": "REL_NOTES"}],
               "blockingControls": []}
    assert [b["controlKey"] for b in _evaluate_governance_block(overlay, set(), set())] == ["REL_NOTES"]


def test_empty_or_none_overlay_is_noop():
    assert _evaluate_governance_block({}, set(), set()) == []
    assert _evaluate_governance_block(None, set(), set()) == []  # type: ignore


def test_satisfied_evidence_keys_from_receipts():
    class _S:
        receipts = {"VERIFY": [
            {"evidence_key": "UNIT_TEST", "status": "PASSED"},
            {"evidenceKey": "SEC", "tool_success": True},
            {"evidence_key": "FAILED_ONE", "status": "failed"},
            {"no_key": True},
        ]}
    keys = _satisfied_evidence_keys(_S())
    assert keys == {"UNIT_TEST", "SEC"}
