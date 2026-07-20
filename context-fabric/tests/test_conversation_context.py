"""
Conversation context — the read path, the feature gate, and the failure modes.

Two things are being proved here, and the first one matters more than the
second:

  1. WITH THE FLAG OFF, NOTHING CHANGES. `build()` returns [], the single-turn
     endpoint's message list is byte-identical to what it has always been, and
     no marker key reaches the wire. That is the entire safety story of this
     change: it ships dark.

  2. With the flag on, memory degrades but never breaks. A store that raises, a
     store that hangs, a conversation that does not exist, a surface outside the
     allowlist — every one of them is [] and a warning, never an exception out
     of an LLM turn.
"""
from __future__ import annotations

import asyncio
import time

import pytest

from context_api_service.app import conversation_store as cs
from context_api_service.app import execute as execute_mod
from context_api_service.app.governed import conversation_context as ctx
from context_api_service.app.governed import llm_client as llm_mod
from context_api_service.app.governed.conversation_budget import CF_PRELUDE_KEY
from context_api_service.app.governed.llm_client import ChatResponse


SYNTHESIS_RC = {"surface": "synthesis", "thread_id": "t1", "capability_id": "cap1"}
CONVERSATION_ID = "sy:thread:t1"


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """A real SQLite file per test — the read path runs against actual SQL."""
    db = tmp_path / "conversations.db"
    monkeypatch.setenv("CONVERSATION_STORE_DB", str(db))
    monkeypatch.delenv("CONVERSATION_STORE_DATABASE_URL", raising=False)
    monkeypatch.delenv("CONTEXT_FABRIC_DATABASE_URL", raising=False)
    monkeypatch.delenv("CF_CONVERSATION_SURFACES", raising=False)
    monkeypatch.delenv("CF_CONVERSATION_TOKEN_BUDGET", raising=False)
    monkeypatch.delenv("CF_CONVERSATION_VERBATIM_PAIRS", raising=False)
    cs.refresh_db_target()
    cs.init_db()
    return cs


@pytest.fixture()
def enabled(monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_ENABLED", "true")


@pytest.fixture()
def disabled(monkeypatch):
    monkeypatch.delenv("CF_CONVERSATION_ENABLED", raising=False)


def _seed(store, *turns: tuple[str, str], conversation_id: str = CONVERSATION_ID) -> None:
    store.ensure_conversation(conversation_id, surface="synthesis", tenant_id="acme")
    for role, content in turns:
        store.append_turn(conversation_id, role, content)


def _build(*args, **kwargs):
    return asyncio.run(ctx.build(*args, **kwargs))


# ── the feature gate ────────────────────────────────────────────────────────


def test_disabled_by_default(store, monkeypatch):
    monkeypatch.delenv("CF_CONVERSATION_ENABLED", raising=False)
    _seed(store, ("user", "remember this"), ("assistant", "noted"))
    assert ctx.is_enabled() is False
    assert _build(SYNTHESIS_RC) == []


def test_disabled_flag_does_not_even_touch_the_store(store, disabled, monkeypatch):
    # The gate is checked FIRST, before identity resolution and before any I/O.
    def _explode(*_a, **_k):
        raise AssertionError("the store must not be read while the flag is off")

    monkeypatch.setattr(cs, "get_conversation", _explode)
    assert _build(SYNTHESIS_RC) == []


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
def test_truthy_values_enable_it(store, monkeypatch, value):
    monkeypatch.setenv("CF_CONVERSATION_ENABLED", value)
    assert ctx.is_enabled() is True


@pytest.mark.parametrize("value", ["", "0", "false", "no", "off", "maybe"])
def test_everything_else_leaves_it_dark(store, monkeypatch, value):
    monkeypatch.setenv("CF_CONVERSATION_ENABLED", value)
    assert ctx.is_enabled() is False


def test_surface_allowlist_narrows_the_rollout(store, enabled, monkeypatch):
    _seed(store, ("user", "hello"), ("assistant", "hi"))
    monkeypatch.setenv("CF_CONVERSATION_SURFACES", "room_copilot,board_copilot")
    assert _build(SYNTHESIS_RC) == []

    monkeypatch.setenv("CF_CONVERSATION_SURFACES", "room_copilot,synthesis")
    assert len(_build(SYNTHESIS_RC)) == 2


def test_an_empty_allowlist_means_every_conversational_surface(store, enabled, monkeypatch):
    _seed(store, ("user", "hello"))
    monkeypatch.setenv("CF_CONVERSATION_SURFACES", "   ")
    assert len(_build(SYNTHESIS_RC)) == 1


def test_a_set_allowlist_is_exhaustive_so_an_unnamed_surface_stays_dark(store, enabled, monkeypatch):
    # An explicit conversation id on a run_context with no surface resolves with
    # surface=None. With an allowlist configured that must stay closed, not
    # default open.
    _seed(store, ("user", "hello"), conversation_id="explicit-1")
    monkeypatch.setenv("CF_CONVERSATION_SURFACES", "synthesis")
    assert _build({}, "explicit-1") == []


# ── identity ────────────────────────────────────────────────────────────────


def test_a_turn_with_no_conversation_gets_nothing(store, enabled):
    # The one-shot extractors live here permanently — see conversation_identity
    # rule 1. Giving them history would be a correctness regression.
    assert _build({"surface": "spec_generation", "capability_id": "cap1"}) == []
    assert _build(None) == []
    assert _build({}) == []


def test_an_unknown_conversation_is_empty_not_an_error(store, enabled):
    assert _build({"surface": "synthesis", "thread_id": "never-seen"}) == []


def test_an_explicit_id_wins(store, enabled):
    _seed(store, ("user", "from the explicit one"), conversation_id="explicit-1")
    out = _build(SYNTHESIS_RC, "explicit-1")
    assert [m["content"] for m in out] == ["from the explicit one"]


# ── what comes back ─────────────────────────────────────────────────────────


def test_oldest_first_ordering_survives_into_the_prompt(store, enabled):
    _seed(
        store,
        ("user", "what is the gate for?"),
        ("assistant", "blocking promotion"),
        ("user", "and the waiver?"),
        ("assistant", "per control key"),
    )
    out = _build(SYNTHESIS_RC)
    assert [m["role"] for m in out] == ["user", "assistant", "user", "assistant"]
    assert [m["content"] for m in out] == [
        "what is the gate for?",
        "blocking promotion",
        "and the waiver?",
        "per control key",
    ]


def test_every_returned_message_is_tagged_as_prelude(store, enabled):
    _seed(store, ("user", "a"), ("assistant", "b"))
    assert all(m[CF_PRELUDE_KEY] is True for m in _build(SYNTHESIS_RC))


def test_no_tool_role_message_can_appear(store, enabled, monkeypatch):
    # The store refuses tool traffic on write, so force it in on the read side
    # to prove the read path filters too.
    _seed(store, ("user", "what does it do?"))
    real = cs.recent_turns

    def _with_tool_traffic(*args, **kwargs):
        rows = list(real(*args, **kwargs))
        rows.append({"role": "tool", "content": '{"result": "leaked"}', "seq": 99})
        return rows

    monkeypatch.setattr(cs, "recent_turns", _with_tool_traffic)
    out = _build(SYNTHESIS_RC)
    assert [m["role"] for m in out] == ["user"]
    assert not any("leaked" in m["content"] for m in out)


def test_the_summary_leads_and_the_summarised_span_is_not_replayed(store, enabled):
    _seed(store, *[("user", f"m{i}") for i in range(8)])
    store.set_summary(CONVERSATION_ID, "they scoped the gate", through_seq=5)
    out = _build(SYNTHESIS_RC)
    assert out[0]["content"].startswith("[CONVERSATION SUMMARY THROUGH TURN 5]")
    # Only the uncovered tail rides verbatim — nothing is both summarised and replayed.
    assert [m["content"] for m in out[1:]] == ["m5", "m6", "m7"]


def test_the_verbatim_window_bounds_the_read(store, enabled, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "2")
    _seed(store, *[("user", f"m{i}") for i in range(20)])
    captured: dict = {}
    real = cs.recent_turns

    def _spy(conversation_id, limit, **kwargs):
        captured["limit"] = limit
        return real(conversation_id, limit, **kwargs)

    monkeypatch.setattr(cs, "recent_turns", _spy)
    out = _build(SYNTHESIS_RC)
    # 2 pairs ⇒ 4 messages asked for, 4 returned. Older history is the
    # summary's job, so fetching it would be bytes we then throw away.
    assert captured["limit"] == 4
    assert [m["content"] for m in out] == ["m16", "m17", "m18", "m19"]


def test_a_known_model_window_tightens_the_budget(store, enabled, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "6")
    _seed(store, *[("user", "x" * 4000) for _ in range(6)])
    # 4k-token window ⇒ 1000-token budget ⇒ one 1000-token turn.
    assert len(_build(SYNTHESIS_RC, model_input_window=4_000)) == 1
    # No window ⇒ the 12000 default ⇒ all six fit.
    assert len(_build(SYNTHESIS_RC)) == 6


# ── memory degrades, it never fails a turn ──────────────────────────────────


def test_a_store_exception_returns_empty_rather_than_raising(store, enabled, monkeypatch):
    def _boom(*_a, **_k):
        raise RuntimeError("relation cf_conversations does not exist")

    monkeypatch.setattr(cs, "get_conversation", _boom)
    assert _build(SYNTHESIS_RC) == []


def test_an_exception_reading_turns_also_degrades(store, enabled, monkeypatch):
    _seed(store, ("user", "hello"))

    def _boom(*_a, **_k):
        raise RuntimeError("connection reset")

    monkeypatch.setattr(cs, "recent_turns", _boom)
    assert _build(SYNTHESIS_RC) == []


def test_a_slow_read_times_out_into_empty(store, enabled, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_READ_TIMEOUT_SEC", "0.05")

    def _hang(*_a, **_k):
        time.sleep(0.6)
        raise AssertionError("should have been abandoned")

    monkeypatch.setattr(ctx, "_load", _hang)

    async def _timed():
        started = time.monotonic()
        out = await ctx.build(SYNTHESIS_RC)
        return out, time.monotonic() - started

    # Timed inside the coroutine: asyncio.run() joins the worker pool on the way
    # out, so measuring around it would measure the abandoned sleep, not the
    # turn's own wait. In the service the loop is long-lived and the turn just
    # carries on.
    out, elapsed = asyncio.run(_timed())
    assert out == []
    assert elapsed < 0.5


def test_a_malformed_conversation_row_degrades(store, enabled, monkeypatch):
    monkeypatch.setattr(cs, "get_conversation", lambda *_a, **_k: {"summary_through_seq": "not-a-number"})
    assert _build(SYNTHESIS_RC) == []


# ── splice_prelude ──────────────────────────────────────────────────────────


def test_splice_with_no_prelude_returns_the_same_object():
    messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]
    assert ctx.splice_prelude(messages, []) is messages
    assert ctx.splice_prelude(messages, None) is messages


def test_splice_lands_after_the_system_prompt_and_before_the_current_turn():
    messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "now"}]
    prelude = [{"role": "user", "content": "then"}, {"role": "assistant", "content": "ok"}]
    out = ctx.splice_prelude(messages, prelude)
    assert [m["content"] for m in out] == ["s", "then", "ok", "now"]


def test_splice_targets_the_last_user_message_when_there_are_several():
    messages = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "composed layer"},
        {"role": "assistant", "content": "ack"},
        {"role": "user", "content": "now"},
    ]
    out = ctx.splice_prelude(messages, [{"role": "user", "content": "then"}])
    assert [m["content"] for m in out] == ["s", "composed layer", "ack", "then", "now"]


def test_splice_lands_after_the_system_block_when_there_is_no_user_turn():
    messages = [{"role": "system", "content": "a"}, {"role": "system", "content": "b"}]
    out = ctx.splice_prelude(messages, [{"role": "user", "content": "then"}])
    assert [m["content"] for m in out] == ["a", "b", "then"]


# ── the single-turn endpoint ────────────────────────────────────────────────


def _run_endpoint(req, monkeypatch, ):
    captured: dict = {}

    async def _fake_gateway(**kwargs):
        captured.update(kwargs)
        return ChatResponse(
            content="the answer", tool_calls=[], finish_reason="stop",
            input_tokens=10, output_tokens=5, latency_ms=1,
            provider="mock", model="mock-1", model_alias="mock-fast", estimated_cost=0.0,
        )

    monkeypatch.setattr(llm_mod, "call_gateway_chat", _fake_gateway)
    monkeypatch.setattr(execute_mod, "emit_audit_event", lambda **k: None)
    out = asyncio.new_event_loop().run_until_complete(execute_mod.execute_governed_single_turn(req))
    return out, captured


def _request(**overrides):
    payload = {
        "trace_id": "t1",
        "task": "what did we decide?",
        "system_prompt": "You are precise.",
        "run_context": dict(SYNTHESIS_RC),
        "model_overrides": {"modelAlias": "mock-fast"},
    }
    payload.update(overrides)
    return execute_mod.GovernedSingleTurnRequest(**payload)


def test_endpoint_messages_are_byte_identical_with_the_flag_off(store, disabled, monkeypatch):
    # THE regression guard for this whole change. A populated conversation plus
    # a resolvable surface — and still exactly the two messages this endpoint
    # has always sent.
    _seed(store, ("user", "we decided to ship the gate"), ("assistant", "recorded"))
    _out, captured = _run_endpoint(_request(), monkeypatch)
    assert captured["messages"] == [
        {"role": "system", "content": "You are precise."},
        {"role": "user", "content": "what did we decide?"},
    ]


def test_endpoint_injects_history_between_system_and_user_when_enabled(store, enabled, monkeypatch):
    _seed(store, ("user", "we decided to ship the gate"), ("assistant", "recorded"))
    _out, captured = _run_endpoint(_request(), monkeypatch)
    assert [m["role"] for m in captured["messages"]] == ["system", "user", "assistant", "user"]
    assert [m["content"] for m in captured["messages"]] == [
        "You are precise.",
        "we decided to ship the gate",
        "recorded",
        "what did we decide?",
    ]


def test_endpoint_still_answers_when_the_store_is_broken(store, enabled, monkeypatch):
    monkeypatch.setattr(cs, "get_conversation", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("down")))
    out, captured = _run_endpoint(_request(), monkeypatch)
    assert out["status"] == "COMPLETED"
    assert len(captured["messages"]) == 2


def test_the_prelude_marker_never_reaches_the_wire(store, enabled, monkeypatch):
    # `_build_chat_body` strips it: the gateway forwards message dicts to the
    # provider, and OpenAI rejects unrecognised message fields.
    _seed(store, ("user", "prior"), ("assistant", "reply"))
    _out, captured = _run_endpoint(_request(), monkeypatch)
    assert any(m.get(CF_PRELUDE_KEY) for m in captured["messages"])  # tagged in-process
    body = llm_mod._build_chat_body(
        messages=captured["messages"], tools=None, model_alias="mock-fast",
        expected_provider=None, expected_model=None, temperature=None,
        max_output_tokens=None, thinking_budget=None, prompt_cache=False,
        prompt_cache_key=None,
    )
    assert all(CF_PRELUDE_KEY not in m for m in body["messages"])
    assert [m["content"] for m in body["messages"]] == [
        "You are precise.", "prior", "reply", "what did we decide?",
    ]
