"""M74 Phase 2B — eval feedback injection tests.

Pure-function tests of ``_render_eval_feedback_message``. The wiring
into ``run_stage`` (initial-history insert) is covered indirectly by
the governed-loop tests once vars.eval_feedback is set; here we pin
the renderer contract in isolation.

Shape match: audit-gov's getLatestEvalFeedbackForSession response.
Any drift breaks the closed loop silently — the renderer would either
return None or render the wrong fields. These tests are the contract.
"""
from __future__ import annotations

from context_api_service.app.governed.stage_driver import (
    _render_eval_feedback_message,
)


def _feedback(failing: list[dict]) -> dict:
    """Build a minimal EvalFeedback payload matching audit-gov's shape."""
    return {
        "eval_run_id": "er-001",
        "status": "FAILED",
        "pass_rate": 0.4,
        "created_at": "2026-05-23T10:00:00Z",
        "metadata": {"stageKey": "develop", "attempt": 2},
        "failing_results": failing,
    }


# ── happy paths ─────────────────────────────────────────────────────────────


def test_renders_user_message_with_judge_failure():
    fb = _feedback([
        {
            "evaluator_kind": "llm_judge",
            "score": 2,
            "reason": "Diff doesn't handle null input to validateEmail",
            "evidence": {"criteria_failed": ["null input handling"]},
        },
    ])
    msg = _render_eval_feedback_message(fb)
    assert msg is not None
    assert msg["role"] == "user"
    assert "[QUALITY-GATE FEEDBACK]" in msg["content"]
    assert "previous attempt" in msg["content"]
    assert "pass_rate=0.4" in msg["content"]
    assert "eval_run_id=er-001" in msg["content"]
    assert "llm_judge" in msg["content"]
    assert "score=2" in msg["content"]
    assert "validateEmail" in msg["content"]
    # Steering line at the end
    assert "Do NOT re-emit" in msg["content"]


def test_renders_multiple_failing_evaluators():
    fb = _feedback([
        {"evaluator_kind": "llm_judge", "score": 2, "reason": "missing edge case"},
        {"evaluator_kind": "rule_based", "score": 0, "reason": "ImportError matched"},
        {"evaluator_kind": "expected_output_contains", "score": 0, "reason": "missing 'fixed'"},
    ])
    msg = _render_eval_feedback_message(fb)
    assert msg is not None
    body = msg["content"]
    assert "llm_judge" in body
    assert "rule_based" in body
    assert "expected_output_contains" in body
    assert "missing edge case" in body
    assert "ImportError matched" in body


def test_truncates_to_top_5_with_count():
    fb = _feedback([
        {"evaluator_kind": f"ev{i}", "score": i % 3, "reason": f"reason {i}"}
        for i in range(8)
    ])
    msg = _render_eval_feedback_message(fb)
    assert msg is not None
    body = msg["content"]
    # First 5 should appear
    for i in range(5):
        assert f"ev{i}" in body, f"ev{i} expected in body"
    # 6th onwards rolled into the "and N more" marker
    assert "and 3 more" in body
    assert "ev5" not in body


def test_reason_text_capped_per_entry():
    long_reason = "x" * 1000
    fb = _feedback([
        {"evaluator_kind": "llm_judge", "score": 1, "reason": long_reason},
    ])
    msg = _render_eval_feedback_message(fb)
    assert msg is not None
    # 600-char cap per entry; the line for that one entry must be <= 700
    # chars (cap + prefix). Total body unconstrained.
    lines = msg["content"].split("\n")
    judge_line = next((line for line in lines if "llm_judge" in line), "")
    assert len(judge_line) <= 700, f"line too long: {len(judge_line)}"


def test_score_none_renders_as_na():
    fb = _feedback([
        {"evaluator_kind": "latency", "score": None, "reason": "p95 exceeded"},
    ])
    msg = _render_eval_feedback_message(fb)
    assert msg is not None
    assert "score=n/a" in msg["content"]


def test_empty_reason_replaced_with_placeholder():
    fb = _feedback([
        {"evaluator_kind": "llm_judge", "score": 3, "reason": "   "},
    ])
    msg = _render_eval_feedback_message(fb)
    assert msg is not None
    assert "(no reason text)" in msg["content"]


# ── defensive paths (return None silently) ─────────────────────────────────


def test_none_input_returns_none():
    assert _render_eval_feedback_message(None) is None


def test_non_dict_input_returns_none():
    assert _render_eval_feedback_message("string") is None
    assert _render_eval_feedback_message([]) is None
    assert _render_eval_feedback_message(42) is None


def test_missing_failing_results_returns_none():
    fb = {
        "eval_run_id": "er-x",
        "status": "FAILED",
        "pass_rate": 0.0,
        # failing_results key missing entirely
    }
    assert _render_eval_feedback_message(fb) is None


def test_empty_failing_results_returns_none():
    """An eval-run with 0 failures shouldn't render feedback (the gate
    wouldn't have blocked, but the closed loop is still safe)."""
    assert _render_eval_feedback_message(_feedback([])) is None


def test_failing_results_not_list_returns_none():
    fb = {
        "eval_run_id": "er-x",
        "failing_results": "not a list",
    }
    assert _render_eval_feedback_message(fb) is None


def test_malformed_entries_are_skipped_not_crashed():
    """A non-dict entry in failing_results shouldn't crash the renderer;
    it should silently skip just that one. Defensive against schema drift."""
    fb = _feedback([
        {"evaluator_kind": "llm_judge", "score": 2, "reason": "valid entry"},
        "not a dict",
        {"evaluator_kind": "rule_based", "score": 0, "reason": "also valid"},
    ])
    msg = _render_eval_feedback_message(fb)
    assert msg is not None
    body = msg["content"]
    assert "llm_judge" in body
    assert "rule_based" in body
    # The string shouldn't appear as a bullet
    assert "not a dict" not in body
