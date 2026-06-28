"""Unit tests for the #20 toolPolicy.approvalRequired gate (waiver-based).

Covers the pure waiver-filter that decides which approvalRequired tools still
need approval. The full halt→waiver→resume→dispatch flow reuses the existing
GOVERNANCE_BLOCKED + GovernanceWaiver machinery and is exercised on a live stack.
"""
from __future__ import annotations

from context_api_service.app.governed.turn import _unwaived_approval_tools

_OVERLAY = {"toolPolicy": {"approvalRequired": ["deploy", "drop_db"]}}


def test_disabled_is_always_empty() -> None:
    # Flag off → legacy advisory behavior, regardless of overlay/waivers.
    assert _unwaived_approval_tools(_OVERLAY, [], enabled=False) == set()
    assert _unwaived_approval_tools(_OVERLAY, ["TOOL_APPROVAL:deploy"], enabled=False) == set()


def test_enabled_no_waivers_returns_all_approval_tools() -> None:
    assert _unwaived_approval_tools(_OVERLAY, [], enabled=True) == {"deploy", "drop_db"}
    assert _unwaived_approval_tools(_OVERLAY, None, enabled=True) == {"deploy", "drop_db"}


def test_active_waiver_releases_its_tool() -> None:
    assert _unwaived_approval_tools(_OVERLAY, ["TOOL_APPROVAL:deploy"], enabled=True) == {"drop_db"}
    assert _unwaived_approval_tools(
        _OVERLAY, ["TOOL_APPROVAL:deploy", "TOOL_APPROVAL:drop_db"], enabled=True
    ) == set()
    # An unrelated waiver doesn't release an approval tool.
    assert _unwaived_approval_tools(_OVERLAY, ["SOME_OTHER_CONTROL"], enabled=True) == {"deploy", "drop_db"}


def test_defensive_on_missing_or_bad_shapes() -> None:
    assert _unwaived_approval_tools(None, [], enabled=True) == set()
    assert _unwaived_approval_tools({}, [], enabled=True) == set()
    assert _unwaived_approval_tools({"toolPolicy": "nope"}, [], enabled=True) == set()
    assert _unwaived_approval_tools({"toolPolicy": {}}, [], enabled=True) == set()
