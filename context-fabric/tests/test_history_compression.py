"""M74 Phase 3A — history compression tests."""
from __future__ import annotations

import json

from context_api_service.app.governed.history_compression import (
    DEFAULT_RECENT_TURNS,
    _split_into_groups,
    _summarise_tool_args,
    compress_history,
)


def _assistant(content: str = "", tool_calls: list[dict] | None = None) -> dict:
    """Build an assistant-role message (the marker for a turn boundary)."""
    return {"role": "assistant", "content": content, "tool_calls": tool_calls or []}


def _tool(content: str, tool_call_id: str = "ti-1") -> dict:
    return {"role": "tool", "content": content, "tool_call_id": tool_call_id}


def _user(content: str) -> dict:
    return {"role": "user", "content": content}


def _tool_call(name: str, args: dict, tc_id: str = "tc-1") -> dict:
    return {
        "id": tc_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args)},
    }


def _turn(name: str, args: dict, text: str = "") -> list[dict]:
    """Synthesize a typical turn group: assistant with one tool call,
    one tool result. Same shape stage_driver._history_from_turn produces."""
    return [
        _assistant(text, [_tool_call(name, args)]),
        _tool(json.dumps({"result": f"result of {name}"}), "tc-1"),
    ]


# ── splitting ───────────────────────────────────────────────────────────────


def test_split_returns_empty_when_messages_empty():
    prelude, groups = _split_into_groups([])
    assert prelude == []
    assert groups == []


def test_split_treats_pre_assistant_messages_as_prelude():
    msgs = [
        _user("[QUALITY-GATE FEEDBACK] previous attempt..."),
        _user("initial history from caller"),
        *_turn("read_file", {"path": "a.py"}),
    ]
    prelude, groups = _split_into_groups(msgs)
    assert len(prelude) == 2
    assert prelude[0]["content"].startswith("[QUALITY-GATE")
    assert len(groups) == 1
    assert groups[0][0]["role"] == "assistant"


def test_split_groups_by_assistant_boundary():
    msgs = [
        *_turn("read_file", {"path": "a.py"}),
        *_turn("search_code", {"query": "foo"}),
        *_turn("repo_map", {}),
    ]
    prelude, groups = _split_into_groups(msgs)
    assert prelude == []
    assert len(groups) == 3
    for g in groups:
        assert g[0]["role"] == "assistant"


def test_split_attaches_post_turn_user_message_to_prior_group():
    """An auto-verify injection (Phase 1A) is a user message that follows
    the turn it commented on. Goes with that turn for compression."""
    msgs = [
        *_turn("apply_patch", {"patch": "..."}),
        _user("[AUTO-VERIFY] PASSED"),
        *_turn("read_file", {"path": "after.py"}),
    ]
    _, groups = _split_into_groups(msgs)
    assert len(groups) == 2
    # The user message rides with turn 1.
    assert len(groups[0]) == 3
    assert groups[0][2]["content"].startswith("[AUTO-VERIFY]")


# ── _summarise_tool_args ────────────────────────────────────────────────────


def test_summarise_args_picks_preferred_field():
    assert _summarise_tool_args('{"path": "src/x.py", "extra": "noise"}') == "path=src/x.py"
    assert _summarise_tool_args('{"query": "foo"}') == "query=foo"
    assert _summarise_tool_args('{"command": "pytest"}') == "command=pytest"


def test_summarise_args_truncates_long_values():
    long_path = "a" * 200
    out = _summarise_tool_args(json.dumps({"path": long_path}))
    assert out.startswith("path=")
    assert "..." in out
    assert len(out) < 80


def test_summarise_args_falls_back_to_first_key_when_no_preferred():
    assert _summarise_tool_args('{"alpha": 1, "beta": 2}') in ("alpha=1", "beta=2")


def test_summarise_args_handles_invalid_json():
    out = _summarise_tool_args("not-json{")
    assert "not-json" in out


def test_summarise_args_handles_empty():
    assert _summarise_tool_args("") == ""


# ── compress_history happy paths ───────────────────────────────────────────


def test_under_threshold_returns_unchanged():
    msgs = [*_turn("read_file", {"path": "a.py"}), *_turn("read_file", {"path": "b.py"})]
    assert compress_history(msgs, recent_turns=8) is msgs or compress_history(msgs, recent_turns=8) == msgs


def test_empty_input_returns_empty():
    assert compress_history([], recent_turns=8) == []


def test_recent_turns_zero_is_noop():
    msgs = [*_turn("x", {})] * 5  # well over threshold
    out = compress_history(msgs, recent_turns=0)
    assert out == msgs


def test_over_threshold_compresses_oldest_keeps_recent():
    # 10 turns; keep most-recent 4, breadcrumb the older 6
    msgs: list[dict] = []
    for i in range(10):
        msgs.extend(_turn("read_file", {"path": f"file{i}.py"}, text=f"reading {i}"))
    out = compress_history(msgs, recent_turns=4)
    # 6 breadcrumbs (user role) + 4 verbatim turns × 2 messages each = 14 messages
    assert len(out) == 6 + 8

    # First 6 are breadcrumbs
    for i in range(6):
        assert out[i]["role"] == "user"
        assert f"[TURN-{i + 1}-RECAP]" in out[i]["content"]
        assert "read_file" in out[i]["content"]
        assert f"file{i}.py" in out[i]["content"]
    # Last 8 are verbatim (4 turns × assistant + tool)
    for j in range(8):
        original = msgs[6 * 2 + j]
        verbatim = out[6 + j]
        assert verbatim == original


def test_prelude_preserved_above_breadcrumbs():
    """Eval-feedback and caller initial_history should never get compressed
    away — they're the closed-loop signal + caller context."""
    prelude = [
        _user("[QUALITY-GATE FEEDBACK] previous attempt scored 2/5..."),
        _user("operator note"),
    ]
    msgs = list(prelude)
    for i in range(10):
        msgs.extend(_turn("read_file", {"path": f"f{i}.py"}))
    out = compress_history(msgs, recent_turns=3)
    # First two are the prelude verbatim
    assert out[0] == prelude[0]
    assert out[1] == prelude[1]
    # Next 7 are breadcrumbs, then 6 verbatim
    assert all("[TURN-" in m["content"] for m in out[2:9])


def test_breadcrumb_includes_assistant_text_when_present():
    msgs: list[dict] = []
    for i in range(10):
        msgs.extend(_turn(
            "search_code",
            {"query": f"q{i}"},
            text=f"I will now search for q{i} because it matters",
        ))
    out = compress_history(msgs, recent_turns=4)
    first_breadcrumb = out[0]
    assert 'said: "I will now search' in first_breadcrumb["content"]


def test_breadcrumb_truncates_long_assistant_text():
    long_text = "x" * 500
    msgs: list[dict] = []
    for i in range(10):
        msgs.extend(_turn("t", {}, text=long_text if i < 6 else "short"))
    out = compress_history(msgs, recent_turns=4)
    first_breadcrumb = out[0]
    # Content cap is ~120 chars on text snippet; breadcrumb should be well under 300
    assert len(first_breadcrumb["content"]) < 400


def test_idempotent_on_already_compressed_history():
    """Running compress twice produces the same result (the second call's
    history has fewer turn-groups so it's effectively a no-op)."""
    msgs: list[dict] = []
    for i in range(20):
        msgs.extend(_turn("read_file", {"path": f"f{i}.py"}))
    once = compress_history(msgs, recent_turns=4)
    twice = compress_history(once, recent_turns=4)
    # After the first pass the breadcrumbs become prelude (user role,
    # not assistant), so the second pass sees only 4 turn groups —
    # under threshold — and returns as-is.
    assert twice == once


def test_breadcrumb_handles_empty_turn():
    """An assistant message with no content and no tool calls (degenerate
    case) renders a placeholder rather than crashing."""
    msgs = [_assistant("", [])]
    # Pad with enough turns to trigger compression
    for i in range(10):
        msgs.extend(_turn("t", {}))
    out = compress_history(msgs, recent_turns=4)
    # First breadcrumb is the degenerate turn
    assert "(empty turn)" in out[0]["content"]


def test_default_recent_turns_exported_for_callers():
    """stage_driver's signature defaults to this; tests pin the value
    so an accidental change in the constants module surfaces here."""
    assert DEFAULT_RECENT_TURNS == 8
