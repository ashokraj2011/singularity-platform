"""Unit tests for the run-outcome memory capture (#25 write slice).

Covers the pure helpers + the enable/stop-reason gating. The actual POST to
agent-runtime is best-effort + flag-gated and is exercised end-to-end on a live
stack (it needs the agent-runtime memory endpoint).
"""
from __future__ import annotations

import os

from context_api_service.app.governed.memory_capture import (
    build_outcome_narrative,
    capture_enabled,
    run_execution_id,
)


def test_run_execution_id_precedence_and_blanks() -> None:
    assert run_execution_id({"instanceId": "inst-1", "trace_id": "t"}) == "inst-1"
    assert run_execution_id({"work_item_id": "wi-9"}) == "wi-9"
    assert run_execution_id({"traceId": "tr-2"}) == "tr-2"
    assert run_execution_id({}) is None
    assert run_execution_id({"instanceId": "   "}) is None  # blank ignored


def test_build_outcome_narrative_includes_key_facts_and_caps_length() -> None:
    n = build_outcome_narrative(
        stage_key="loop.develop",
        agent_role="DEVELOPER",
        final_phase="FINALIZE",
        stop_reason="FINALIZED",
        totals={"input_tokens": 100, "output_tokens": 20, "tool_calls": 3, "tools_refused": 1},
    )
    assert "loop.develop" in n and "DEVELOPER" in n
    assert "FINALIZED" in n and "FINALIZE" in n
    assert "100 in / 20 out" in n and "3 tool calls (1 refused)" in n

    huge = build_outcome_narrative(
        stage_key="x" * 9000, agent_role=None, final_phase="P", stop_reason="S", totals=None,
    )
    assert len(huge) <= 4000


def test_capture_disabled_by_default_and_togglable(monkeypatch) -> None:
    monkeypatch.delenv("CF_CAPTURE_RUN_MEMORY", raising=False)
    assert capture_enabled() is False
    for on in ("1", "true", "YES", "on"):
        monkeypatch.setenv("CF_CAPTURE_RUN_MEMORY", on)
        assert capture_enabled() is True
    monkeypatch.setenv("CF_CAPTURE_RUN_MEMORY", "false")
    assert capture_enabled() is False
