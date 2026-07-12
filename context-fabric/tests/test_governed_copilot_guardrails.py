"""Guardrails on the copilot executor's ``--allow-all`` blind spot.

The Copilot CLI runs the whole think→edit→run loop internally, so the platform
applies no per-tool governance mid-run. These tests cover the two levers CF now
has: an opt-out for ``--allow-all`` (blast-radius control) and carrying the
mcp-server governance / over-budget signal through onto the receipt so a single
delegated tool-run is never mistaken for a governed loop.
"""
from __future__ import annotations

from context_api_service.app.governed.copilot_executor import (
    _copilot_allow_all,
    parse_copilot_result,
)


def test_allow_all_defaults_true() -> None:
    assert _copilot_allow_all(None) is True
    assert _copilot_allow_all({}) is True
    assert _copilot_allow_all({"other": 1}) is True


def test_allow_all_respects_opt_out() -> None:
    assert _copilot_allow_all({"copilot_allow_all": False}) is False
    assert _copilot_allow_all({"copilot_allow_all": True}) is True
    # truthy/falsey coercion for non-bool run_context values
    assert _copilot_allow_all({"copilot_allow_all": 0}) is False
    assert _copilot_allow_all({"copilot_allow_all": "yes"}) is True


def test_parse_carries_governance_and_over_budget() -> None:
    out = parse_copilot_result(
        {
            "summary": "did work",
            "governance": {"in_loop": False, "approval": "post_hoc"},
            "overBudget": True,
        }
    )
    assert out["governance"] == {"in_loop": False, "approval": "post_hoc"}
    assert out["over_budget"] is True


def test_parse_defaults_when_governance_absent() -> None:
    out = parse_copilot_result({"summary": "s"})
    assert out["governance"] is None
    assert out["over_budget"] is False


def test_parse_tolerates_nested_output_wrapper_and_bad_governance() -> None:
    # tool-run sometimes nests the handler output under an extra `output` key; a
    # non-dict governance value must degrade to None, and overBudget coerces to bool.
    out = parse_copilot_result({"output": {"summary": "s", "governance": "nope", "overBudget": 1}})
    assert out["governance"] is None
    assert out["over_budget"] is True
