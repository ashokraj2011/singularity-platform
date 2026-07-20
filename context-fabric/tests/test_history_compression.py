"""M74 Phase 3A — history compression tests."""
from __future__ import annotations

import json

from context_api_service.app.governed.conversation_budget import CF_PRELUDE_KEY
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


# ── Review fix #1 (2026-05-23) — turn-index preservation ─────────────────────


def test_breadcrumb_turn_index_preserved_across_compression_passes():
    """Regression test for the turn-index reset bug.

    Before the fix: stage_driver calls compress_history every turn.
    On the second call, the previous "[TURN-N-RECAP]" breadcrumbs
    were user-role messages, so they got swept into `prelude` and
    the new compression run started numbering at 1 again — operators
    saw multiple "[TURN-1-RECAP]" entries with no chronological
    ordering, which confused both the LLM and post-hoc debuggers.

    After the fix: _count_breadcrumbs offsets the new indices past
    any pre-existing breadcrumbs, so the stream stays monotonic.
    """
    # Build a 20-turn history (10 old + 10 new), compress in two
    # passes, and check the breadcrumb numbering is monotonic.
    first_batch: list[dict] = []
    for i in range(14):
        first_batch.extend(_turn("read_file", {"path": f"old{i}.py"}, text=f"old {i}"))

    # Pass 1: compress with recent_turns=4 → 10 breadcrumbs + 4 verbatim.
    pass1 = compress_history(first_batch, recent_turns=4)
    breadcrumbs_pass1 = [m for m in pass1 if isinstance(m.get("content"), str)
                        and m["content"].startswith("[TURN-")]
    assert len(breadcrumbs_pass1) == 10
    # Pass 1 numbering: 1..10.
    for i, bc in enumerate(breadcrumbs_pass1):
        assert f"[TURN-{i + 1}-RECAP]" in bc["content"]

    # Now simulate 6 more turns happening and compress again.
    second_batch = list(pass1)
    for i in range(6):
        second_batch.extend(_turn("read_file", {"path": f"new{i}.py"}, text=f"new {i}"))

    pass2 = compress_history(second_batch, recent_turns=4)
    breadcrumbs_pass2 = [m for m in pass2 if isinstance(m.get("content"), str)
                        and m["content"].startswith("[TURN-")]
    # Pass 1: 14 turns → 10 breadcrumbs + 4 verbatim.
    # Pass 2 input: 10 breadcrumbs (prelude) + 4 verbatim + 6 new = 10
    # breadcrumbs + 10 verbatim turn groups. With recent_turns=4 we keep
    # 4 verbatim and demote 6 → 10 + 6 = 16 total breadcrumbs.
    assert len(breadcrumbs_pass2) == 16

    # CRITICAL — every TURN-N must be unique and monotonic. Before
    # the fix, the 6 newly-demoted breadcrumbs would re-use indices
    # 1..6, duplicating the existing 1..10 prelude entries.
    seen_indices: list[int] = []
    for bc in breadcrumbs_pass2:
        # Extract the N from "[TURN-N-RECAP]".
        content = bc["content"]
        n_str = content[len("[TURN-"):content.index("-RECAP]")]
        seen_indices.append(int(n_str))
    assert seen_indices == list(range(1, 17)), (
        f"Expected monotonic indices 1..16, got {seen_indices}. "
        "If this fails with duplicates like [1, 2, ..., 10, 1, 2, ..., 6], "
        "the turn-index reset bug has regressed."
    )


def _prelude_user(content: str) -> dict:
    return {"role": "user", "content": content, CF_PRELUDE_KEY: True}


def _prelude_assistant(content: str) -> dict:
    return {"role": "assistant", "content": content, CF_PRELUDE_KEY: True}


def _conversation(pairs: int) -> list[dict]:
    """Injected conversation memory, the shape conversation_budget produces:
    alternating user/assistant, every message tagged."""
    out: list[dict] = []
    for i in range(pairs):
        out.append(_prelude_user(f"prior question {i}"))
        out.append(_prelude_assistant(f"prior answer {i}"))
    return out


def test_injected_assistant_turns_survive_past_turn_nine():
    """THE reason `_cf_prelude` exists.

    `_is_assistant_start` treats any assistant message as the start of a turn
    group. Injected conversation memory contains assistant turns, so untagged it
    would be split into turn groups of its own — groups that fall out of the
    8-turn sliding window and collapse into "[TURN-N-RECAP]" breadcrumbs. The
    memory would work for the first eight turns of a stage and then silently
    evaporate around turn 9, with nothing in the logs to say it had happened.

    Tagged, it is prelude: never grouped, never compressed, verbatim for the
    whole stage.
    """
    prelude = _conversation(3)          # 6 messages, 3 of them assistant-role
    msgs: list[dict] = list(prelude)
    for i in range(14):                 # well past the 8-turn window
        msgs.extend(_turn("read_file", {"path": f"f{i}.py"}, text=f"turn {i}"))

    out = compress_history(msgs, recent_turns=DEFAULT_RECENT_TURNS)

    # Compression definitely fired.
    assert any("[TURN-" in str(m.get("content")) for m in out)
    # Every injected message survived, verbatim and in order, at the head.
    assert out[: len(prelude)] == prelude
    # Specifically the assistant ones — the messages the bug would have eaten.
    injected_assistants = [m for m in out if m.get(CF_PRELUDE_KEY) and m["role"] == "assistant"]
    assert [m["content"] for m in injected_assistants] == [
        "prior answer 0", "prior answer 1", "prior answer 2",
    ]
    # And none of them was turned into a breadcrumb.
    assert not any(
        "prior answer" in str(m.get("content")) and "[TURN-" in str(m.get("content"))
        for m in out
    )


def test_untagged_assistant_history_is_what_the_marker_prevents():
    """The counterexample, pinned so the fix cannot be quietly reverted.

    Same history with the marker stripped: the injected assistant turns become
    turn-group heads, fall out of the window, and come back as breadcrumbs.
    """
    untagged = [
        {k: v for k, v in m.items() if k != CF_PRELUDE_KEY}
        for m in _conversation(3)
    ]
    msgs: list[dict] = list(untagged)
    for i in range(14):
        msgs.extend(_turn("read_file", {"path": f"f{i}.py"}, text=f"turn {i}"))

    out = compress_history(msgs, recent_turns=DEFAULT_RECENT_TURNS)
    assert not any(m.get("content") == "prior answer 0" for m in out)


def test_tagged_prelude_is_never_grouped_whatever_its_position():
    """The guarantee does not depend on the caller splicing at index 0."""
    msgs = [
        *_turn("read_file", {"path": "a.py"}),
        _prelude_assistant("injected mid-list"),
        *_turn("read_file", {"path": "b.py"}),
    ]
    prelude, groups = _split_into_groups(msgs)
    assert prelude == [_prelude_assistant("injected mid-list")]
    assert len(groups) == 2
    assert all(not m.get(CF_PRELUDE_KEY) for g in groups for m in g)


def test_injected_text_that_looks_like_a_breadcrumb_does_not_shift_numbering():
    """A user can paste "[TURN-3-RECAP]" into a chat. Injected conversation text
    is never one of OUR breadcrumbs, so it must not offset the turn indices."""
    msgs: list[dict] = [_prelude_user("[TURN-99-RECAP] pasted from a log")]
    for i in range(12):
        msgs.extend(_turn("read_file", {"path": f"f{i}.py"}))

    out = compress_history(msgs, recent_turns=4)
    breadcrumbs = [
        m for m in out
        if not m.get(CF_PRELUDE_KEY) and str(m.get("content")).startswith("[TURN-")
    ]
    indices = [
        int(m["content"][len("[TURN-"):m["content"].index("-RECAP]")])
        for m in breadcrumbs
    ]
    assert indices == list(range(1, 9))


def test_prelude_marker_survives_repeated_compression_passes():
    msgs: list[dict] = _conversation(2)
    for i in range(10):
        msgs.extend(_turn("read_file", {"path": f"f{i}.py"}))
    once = compress_history(msgs, recent_turns=4)
    for i in range(10, 16):
        once.extend(_turn("read_file", {"path": f"f{i}.py"}))
    twice = compress_history(once, recent_turns=4)

    assert twice[:4] == _conversation(2)


def test_breadcrumb_turn_index_preserved_across_three_passes():
    """Stronger version — three compression passes in a row. Each
    pass should pick up where the previous left off."""
    msgs: list[dict] = []
    for i in range(10):
        msgs.extend(_turn("read_file", {"path": f"f{i}.py"}))

    pass1 = compress_history(msgs, recent_turns=4)
    # Add 4 more turns.
    for i in range(10, 14):
        pass1.extend(_turn("read_file", {"path": f"f{i}.py"}))
    pass2 = compress_history(pass1, recent_turns=4)
    # Add 4 more turns.
    for i in range(14, 18):
        pass2.extend(_turn("read_file", {"path": f"f{i}.py"}))
    pass3 = compress_history(pass2, recent_turns=4)

    breadcrumbs = [m for m in pass3 if isinstance(m.get("content"), str)
                  and m["content"].startswith("[TURN-")]
    indices = [
        int(m["content"][len("[TURN-"):m["content"].index("-RECAP]")])
        for m in breadcrumbs
    ]
    # All indices must be distinct.
    assert len(indices) == len(set(indices)), (
        f"breadcrumb indices have duplicates: {indices}"
    )
    # And monotonically increasing.
    assert indices == sorted(indices), (
        f"breadcrumb indices not monotonic: {indices}"
    )
