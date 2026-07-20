"""
The conversation budget: which part of a conversation is worth sending.

Pure module, so every case here runs with no database and no clock. The
assertions that carry weight are the ones about what survives pressure:

  - the newest turn is never dropped, even when it alone busts the budget
  - the summary is dropped only after the tail cannot shrink further
  - tool-role rows can never become prompt messages, whatever the store hands us
  - oldest-first ordering survives all of it
"""
from __future__ import annotations

from context_api_service.app.governed.conversation_budget import (
    CF_PRELUDE_KEY,
    DEFAULT_TOKEN_BUDGET,
    DEFAULT_VERBATIM_PAIRS,
    estimate_tokens,
    plan_conversation_context,
    resolve_token_budget,
    resolve_verbatim_pairs,
    strip_internal_keys,
)


def _turn(role: str, content: str) -> dict:
    """A store row shape — extra columns included, because the planner must not
    let any of them ride into a prompt."""
    return {
        "id": "row-1",
        "conversation_id": "sy:thread:t1",
        "seq": 1,
        "role": role,
        "content": content,
        "tenant_id": "acme",
        "cf_call_id": "call-1",
        "trace_id": "trace-1",
        "created_at": "2026-07-20T00:00:00Z",
    }


def _pairs(n: int, size: int = 40) -> list[dict]:
    """n user/assistant pairs, each message `size` chars ⇒ size//4 tokens."""
    out: list[dict] = []
    for i in range(n):
        out.append(_turn("user", f"u{i}".ljust(size, ".")))
        out.append(_turn("assistant", f"a{i}".ljust(size, ".")))
    return out


# ── token estimate ──────────────────────────────────────────────────────────


def test_token_estimate_matches_the_rest_of_cf():
    # llm_client and direct_llm_client both use len(text)//4. A third estimate
    # that disagreed would make budget maths incomparable across paths.
    assert estimate_tokens("a" * 400) == 100
    assert estimate_tokens("") == 0
    assert estimate_tokens(None) == 0


# ── budget resolution ───────────────────────────────────────────────────────


def test_budget_defaults_to_the_env_value_when_no_window_is_known(monkeypatch):
    monkeypatch.delenv("CF_CONVERSATION_TOKEN_BUDGET", raising=False)
    assert resolve_token_budget() == DEFAULT_TOKEN_BUDGET
    assert resolve_token_budget(None) == DEFAULT_TOKEN_BUDGET


def test_a_small_model_window_caps_the_budget(monkeypatch):
    monkeypatch.delenv("CF_CONVERSATION_TOKEN_BUDGET", raising=False)
    # 16k window ⇒ a quarter is 4000, well under the 12000 default.
    assert resolve_token_budget(16_000) == 4_000


def test_a_large_model_window_does_not_raise_the_budget(monkeypatch):
    # A 200k window is permission to spend more, not an instruction to. History
    # is context, not the job.
    monkeypatch.delenv("CF_CONVERSATION_TOKEN_BUDGET", raising=False)
    assert resolve_token_budget(200_000) == DEFAULT_TOKEN_BUDGET


def test_env_overrides_both_knobs(monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_TOKEN_BUDGET", "500")
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "2")
    assert resolve_token_budget() == 500
    assert resolve_verbatim_pairs() == 2


def test_garbage_env_falls_back_to_the_default(monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_TOKEN_BUDGET", "not-a-number")
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "")
    assert resolve_token_budget() == DEFAULT_TOKEN_BUDGET
    assert resolve_verbatim_pairs() == DEFAULT_VERBATIM_PAIRS


# ── tier 1: the verbatim tail ───────────────────────────────────────────────


def test_everything_fits_when_the_conversation_is_short():
    turns = _pairs(3)
    plan = plan_conversation_context(None, turns, budget=DEFAULT_TOKEN_BUDGET, verbatim_pairs=6)
    assert [m["content"] for m in plan["messages"]] == [t["content"] for t in turns]
    assert plan["dropped_count"] == 0
    assert plan["reason"] == "within_budget"


def test_oldest_first_ordering_is_preserved():
    # Straight into a prompt. Reversing anywhere downstream is how transcripts
    # end up backwards.
    turns = _pairs(3)
    plan = plan_conversation_context(None, turns, budget=DEFAULT_TOKEN_BUDGET, verbatim_pairs=6)
    roles = [m["role"] for m in plan["messages"]]
    assert roles == ["user", "assistant", "user", "assistant", "user", "assistant"]
    assert plan["messages"][0]["content"].startswith("u0")
    assert plan["messages"][-1]["content"].startswith("a2")


def test_only_the_last_n_pairs_are_verbatim():
    turns = _pairs(10)
    plan = plan_conversation_context(None, turns, budget=DEFAULT_TOKEN_BUDGET, verbatim_pairs=2)
    assert len(plan["messages"]) == 4
    assert plan["messages"][0]["content"].startswith("u8")
    assert plan["dropped_count"] == 16
    assert plan["reason"] == "window_trimmed"


def test_zero_verbatim_pairs_sends_no_tail():
    plan = plan_conversation_context(None, _pairs(4), budget=DEFAULT_TOKEN_BUDGET, verbatim_pairs=0)
    assert plan["messages"] == []


def test_no_turns_and_no_summary_is_an_empty_plan():
    plan = plan_conversation_context(None, [], budget=DEFAULT_TOKEN_BUDGET, verbatim_pairs=6)
    assert plan["messages"] == []
    assert plan["used_tokens"] == 0
    assert plan["dropped_count"] == 0


# ── tier 2: the summary ─────────────────────────────────────────────────────


def test_summary_leads_and_names_its_watermark():
    plan = plan_conversation_context(
        "they agreed to ship the gate first",
        _pairs(2),
        budget=DEFAULT_TOKEN_BUDGET,
        verbatim_pairs=6,
        summary_through_seq=40,
    )
    first = plan["messages"][0]
    assert first["content"].startswith("[CONVERSATION SUMMARY THROUGH TURN 40]")
    assert "they agreed to ship the gate first" in first["content"]
    # Exactly one summary message, and it is in front of the tail.
    assert sum(1 for m in plan["messages"] if "CONVERSATION SUMMARY" in m["content"]) == 1
    assert plan["messages"][1]["content"].startswith("u0")


def test_blank_summary_produces_no_summary_message():
    for blank in (None, "", "   "):
        plan = plan_conversation_context(blank, _pairs(1), budget=DEFAULT_TOKEN_BUDGET, verbatim_pairs=6)
        assert all("CONVERSATION SUMMARY" not in m["content"] for m in plan["messages"])


# ── pressure ────────────────────────────────────────────────────────────────


def test_under_pressure_the_summary_and_the_newest_turn_both_survive():
    # THE case the tiering exists for. Each message is 400 chars ⇒ 100 tokens.
    # A budget that fits the summary plus one turn but not two must keep the
    # summary (all of the older history) AND the newest turn (the live context).
    turns = _pairs(5, size=400)
    summary = "s" * 400
    plan = plan_conversation_context(
        summary, turns, budget=250, verbatim_pairs=6, summary_through_seq=4,
    )
    assert len(plan["messages"]) == 2
    assert plan["messages"][0]["content"].startswith("[CONVERSATION SUMMARY THROUGH TURN 4]")
    assert plan["messages"][-1]["content"] == turns[-1]["content"]
    assert plan["used_tokens"] <= 250
    assert plan["reason"] == "tail_trimmed"


def test_trimming_takes_from_the_oldest_end():
    turns = _pairs(5, size=400)  # 10 messages × 100 tokens
    plan = plan_conversation_context(None, turns, budget=300, verbatim_pairs=6)
    # Three newest survive, in order, and they are the LAST three.
    assert [m["content"] for m in plan["messages"]] == [t["content"] for t in turns[-3:]]
    assert plan["dropped_count"] == 7


def test_the_newest_turn_is_never_dropped_even_when_it_busts_the_budget():
    # A single enormous turn. Returning [] here would be indistinguishable from
    # "this conversation has no history", which is a lie the caller cannot see
    # through — so the plan ships it and says so.
    turns = [_turn("user", "x" * 100_000)]
    plan = plan_conversation_context(None, turns, budget=10, verbatim_pairs=6)
    assert len(plan["messages"]) == 1
    assert plan["messages"][0]["content"] == turns[0]["content"]
    assert plan["reason"] == "over_budget_minimum"
    assert plan["used_tokens"] > 10


def test_the_summary_is_dropped_only_after_the_tail_cannot_shrink():
    turns = _pairs(4, size=400)
    plan = plan_conversation_context(
        "s" * 4000, turns, budget=50, verbatim_pairs=6, summary_through_seq=8,
    )
    # Tail is down to one; the summary went last, and the newest turn stayed.
    assert len(plan["messages"]) == 1
    assert "CONVERSATION SUMMARY" not in plan["messages"][0]["content"]
    assert plan["messages"][0]["content"] == turns[-1]["content"]
    assert plan["reason"] == "over_budget_minimum"


def test_a_zero_budget_still_yields_the_newest_turn():
    plan = plan_conversation_context(None, _pairs(3), budget=0, verbatim_pairs=6)
    assert len(plan["messages"]) == 1
    assert plan["messages"][0]["content"].startswith("a2")


# ── what must never appear ──────────────────────────────────────────────────


def test_tool_role_rows_can_never_become_prompt_messages():
    # Defence in depth. conversation_store refuses tool traffic on WRITE; this
    # is the read side refusing it too, so one schema change cannot put an
    # orphaned tool_result into a prompt (Anthropic 400s the whole request and
    # CF's governed loop has no orphan repair).
    turns = [
        _turn("user", "what does deploy.sh do?"),
        _turn("tool", '{"result": "contents of deploy.sh"}'),
        _turn("system", "you are a helpful assistant"),
        _turn("assistant", "it ships the web bundle"),
    ]
    plan = plan_conversation_context(None, turns, budget=DEFAULT_TOKEN_BUDGET, verbatim_pairs=6)
    assert [m["role"] for m in plan["messages"]] == ["user", "assistant"]
    assert not any(m["role"] == "tool" for m in plan["messages"])


def test_store_columns_never_ride_into_the_prompt():
    plan = plan_conversation_context(None, [_turn("user", "hi")], budget=DEFAULT_TOKEN_BUDGET, verbatim_pairs=6)
    assert set(plan["messages"][0]) == {"role", "content", CF_PRELUDE_KEY}


def test_empty_and_malformed_rows_are_skipped():
    turns = [
        _turn("user", ""),
        _turn("assistant", "   "),
        {"role": "user"},          # no content
        {"content": "orphan"},     # no role
        "not-a-mapping",
        _turn("user", "the only real one"),
    ]
    plan = plan_conversation_context(None, turns, budget=DEFAULT_TOKEN_BUDGET, verbatim_pairs=6)
    assert [m["content"] for m in plan["messages"]] == ["the only real one"]


def test_every_message_is_tagged_as_prelude():
    plan = plan_conversation_context(
        "older context", _pairs(2), budget=DEFAULT_TOKEN_BUDGET, verbatim_pairs=6,
    )
    assert plan["messages"]
    assert all(m[CF_PRELUDE_KEY] is True for m in plan["messages"])


# ── the marker never reaches a provider ─────────────────────────────────────


def test_strip_returns_the_same_object_when_nothing_is_tagged():
    # The flag-off path must allocate nothing and change nothing.
    messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]
    assert strip_internal_keys(messages) is messages


def test_strip_removes_the_marker_but_keeps_everything_else():
    tagged = [
        {"role": "user", "content": "prior", CF_PRELUDE_KEY: True},
        {"role": "assistant", "content": "reply", "tool_calls": [], CF_PRELUDE_KEY: True},
        {"role": "user", "content": "now"},
    ]
    out = strip_internal_keys(tagged)
    assert all(CF_PRELUDE_KEY not in m for m in out)
    assert out[1] == {"role": "assistant", "content": "reply", "tool_calls": []}
    assert out[2] == {"role": "user", "content": "now"}
    # Input untouched — the caller may still need the markers.
    assert tagged[0][CF_PRELUDE_KEY] is True


def test_strip_tolerates_empty_input():
    assert strip_internal_keys([]) == []
    assert strip_internal_keys(None) is None
