"""Unit tests for the run_turn token-budget pre-flight estimator (P1).

Covers the heuristic input-size estimate used to detect a budget blowout
before paying for the gateway round trip. The over-cap warn path in run_turn
itself is exercised end-to-end by the governed integration tests.
"""
from __future__ import annotations

from context_api_service.app.governed.turn import _estimate_input_tokens


def test_empty_input_is_zero() -> None:
    est = _estimate_input_tokens([], None)
    assert est == {"messages": 0, "tools": 0, "total": 0}


def test_counts_message_content() -> None:
    # 40 chars of content -> 40 // 4 == 10 tokens.
    est = _estimate_input_tokens([{"role": "user", "content": "x" * 40}], None)
    assert est["messages"] == 10
    assert est["tools"] == 0
    assert est["total"] == 10


def test_counts_tool_schemas_and_tool_calls() -> None:
    msgs = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "t1", "function": {"name": "do_thing", "arguments": "{}"}}],
        }
    ]
    tools = [{"type": "function", "function": {"name": "do_thing", "parameters": {"type": "object"}}}]
    est = _estimate_input_tokens(msgs, tools)
    assert est["tools"] > 0  # the tool schema list is on the wire
    assert est["messages"] > 0  # tool_calls payload counts even with empty content
    assert est["total"] >= est["tools"]


def test_ignores_none_content_and_non_dict_entries() -> None:
    msgs = [
        {"role": "system", "content": None},
        "not-a-dict",  # defensive: skipped, not crashed on
        {"role": "user", "content": "abcd"},  # 4 chars -> 1 token
    ]
    est = _estimate_input_tokens(msgs, None)  # type: ignore[arg-type]
    assert est["total"] == 1
