"""
Conversation summariser — the second tier, and the promise that it stays off
the request path.

THE GAP THIS CLOSES. conversation_budget always described two tiers: a verbatim
tail, and a summary covering everything older. Only the first was ever real —
`build()` reads with `after_seq=summary_through_seq` and nothing moved that
watermark, so turns older than the window were silently DROPPED and memory was
exactly "last N pairs". `test_the_turns_that_used_to_be_dropped_now_survive` is
the test that pins the fix; everything else protects it.

THE CONSTRAINT THAT MATTERS MOST. Summarising is an LLM call, and it must never
happen on the request path. `test_the_request_path_does_not_wait_for_the_llm`
pins that with a summariser deliberately slower than any acceptable response
time. If that test ever starts passing for the wrong reason — because
`schedule()` began awaiting — chat surfaces would stutter every few turns.

Conventions match the rest of context-fabric/tests/: no pytest-asyncio, drive
coroutines with asyncio.run(), real SQLite per test, patch names on the
importing module.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any
from unittest.mock import patch

import pytest

from context_api_service.app import conversation_store as cs
from context_api_service.app import execute as execute_mod
from context_api_service.app.governed import conversation_context as ctx
from context_api_service.app.governed import conversation_summarizer as summ
from context_api_service.app.governed import llm_client as llm_mod
from context_api_service.app.governed.llm_client import ChatResponse


SYNTHESIS_RC = {
    "surface": "synthesis",
    "thread_id": "t1",
    "capability_id": "cap1",
    "tenant_id": "acme",
}
CONVERSATION_ID = "sy:thread:t1"


@pytest.fixture()
def store(tmp_path, monkeypatch):
    db = tmp_path / "conversations.db"
    monkeypatch.setenv("CONVERSATION_STORE_DB", str(db))
    monkeypatch.delenv("CONVERSATION_STORE_DATABASE_URL", raising=False)
    monkeypatch.delenv("CONTEXT_FABRIC_DATABASE_URL", raising=False)
    monkeypatch.delenv("CF_CONVERSATION_SURFACES", raising=False)
    monkeypatch.delenv("CF_CONVERSATION_ENABLED", raising=False)
    monkeypatch.delenv("CF_CONVERSATION_WRITE_ENABLED", raising=False)
    monkeypatch.delenv("CF_CONVERSATION_SUMMARY_ENABLED", raising=False)
    monkeypatch.delenv("CF_CONVERSATION_SUMMARY_SLACK_TURNS", raising=False)
    monkeypatch.delenv("CF_CONVERSATION_VERBATIM_PAIRS", raising=False)
    monkeypatch.delenv("CF_CONVERSATION_TOKEN_BUDGET", raising=False)
    cs.refresh_db_target()
    cs.init_db()
    cs.ensure_conversation(CONVERSATION_ID, surface="synthesis", tenant_id="acme")
    return cs


@pytest.fixture()
def summarising(monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_SUMMARY_ENABLED", "true")


@pytest.fixture()
def no_mcp(monkeypatch):
    """Force the deterministic fallback: no network in these tests."""
    async def _explode(*_a: Any, **_k: Any):
        raise AssertionError("no HTTP in this test")

    monkeypatch.setattr(summ.httpx.AsyncClient, "post", _explode)
    return None


def _seed_pairs(count: int, *, start: int = 1) -> None:
    for i in range(start, start + count):
        cs.append_turn(CONVERSATION_ID, "user", f"question {i}")
        cs.append_turn(CONVERSATION_ID, "assistant", f"answer {i}")


def _row() -> dict:
    return cs.get_conversation(CONVERSATION_ID)


# ── the gate ────────────────────────────────────────────────────────────────


def test_summarising_is_off_by_default(store):
    assert summ.is_enabled() is False


def test_schedule_does_nothing_while_the_gate_is_shut(store):
    assert summ.schedule(SYNTHESIS_RC) is None


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
def test_truthy_values_enable_it(store, monkeypatch, value):
    monkeypatch.setenv("CF_CONVERSATION_SUMMARY_ENABLED", value)
    assert summ.is_enabled() is True


def test_schedule_on_a_stateless_surface_is_a_no_op(store, summarising):
    assert summ.schedule({"surface": "spec_generation"}) is None
    assert summ.schedule(None) is None


# ── when a summary is worth making ──────────────────────────────────────────


def test_a_short_conversation_is_not_due(store):
    # Everything still fits in the verbatim window; summarising it would put the
    # same turns into the prompt twice.
    assert summ.due_through_seq({"head_seq": 4, "summary_through_seq": 0}) is None


def test_the_target_excludes_the_verbatim_tail(store, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "2")  # 4 turns kept verbatim
    monkeypatch.setenv("CF_CONVERSATION_SUMMARY_SLACK_TURNS", "0")
    assert summ.due_through_seq({"head_seq": 20, "summary_through_seq": 0}) == 16


def test_slack_stops_the_watermark_chasing_the_tail(store, monkeypatch):
    # Without slack every new turn would push exactly one old turn out of the
    # window and trigger a fresh LLM call to fold it in.
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "2")
    monkeypatch.setenv("CF_CONVERSATION_SUMMARY_SLACK_TURNS", "4")
    assert summ.due_through_seq({"head_seq": 20, "summary_through_seq": 14} ) is None
    assert summ.due_through_seq({"head_seq": 20, "summary_through_seq": 11}) == 16


def test_an_already_covered_span_is_not_redone(store, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "2")
    monkeypatch.setenv("CF_CONVERSATION_SUMMARY_SLACK_TURNS", "0")
    assert summ.due_through_seq({"head_seq": 20, "summary_through_seq": 16}) is None


# ── the job ─────────────────────────────────────────────────────────────────


def test_summarising_moves_the_watermark_and_stores_prose(store, no_mcp, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "2")
    monkeypatch.setenv("CF_CONVERSATION_SUMMARY_SLACK_TURNS", "0")
    _seed_pairs(10)  # 20 turns
    through = asyncio.run(summ.summarize_conversation(CONVERSATION_ID))
    assert through == 16
    row = _row()
    assert row["summary_through_seq"] == 16
    assert row["summary_text"].strip()
    assert row["summary_tokens"] > 0


def test_a_conversation_that_is_not_due_is_left_alone(store, no_mcp):
    _seed_pairs(2)
    assert asyncio.run(summ.summarize_conversation(CONVERSATION_ID)) is None
    assert _row()["summary_through_seq"] == 0


def test_a_missing_conversation_is_not_an_error(store, no_mcp):
    assert asyncio.run(summ.summarize_conversation("sy:thread:nope")) is None


def test_the_watermark_only_moves_forward(store, no_mcp, monkeypatch):
    # The store guards this; the summariser leans on it rather than locking.
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "2")
    monkeypatch.setenv("CF_CONVERSATION_SUMMARY_SLACK_TURNS", "0")
    _seed_pairs(10)
    asyncio.run(summ.summarize_conversation(CONVERSATION_ID))
    assert _row()["summary_through_seq"] == 16
    cs.set_summary(CONVERSATION_ID, "a stale summary from a slow run", 8, 5)
    assert _row()["summary_through_seq"] == 16
    assert "stale" not in _row()["summary_text"]


def test_the_rolling_step_feeds_the_prior_summary_back_in(store, monkeypatch):
    # Rolling, not re-folding: the prior summary carries everything older, so
    # the prompt stays O(new turns) instead of growing with the conversation.
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "2")
    monkeypatch.setenv("CF_CONVERSATION_SUMMARY_SLACK_TURNS", "0")
    _seed_pairs(10)
    cs.set_summary(CONVERSATION_ID, "they agreed to use the event bus", 8, 10)

    seen: dict = {}

    async def _capture(messages, conversation_id=None):
        seen["messages"] = list(messages)
        return summ.normalize_summary({"current_goal": "carry on"})

    monkeypatch.setattr(summ, "summarize_with_llm", _capture)
    asyncio.run(summ.summarize_conversation(CONVERSATION_ID))

    first = seen["messages"][0]["content"]
    assert "they agreed to use the event bus" in first
    assert "THROUGH TURN 8" in first
    # Only the turns the prior summary does NOT cover ride along after it.
    assert all("question 1:" not in m["content"] for m in seen["messages"][1:])
    assert len(seen["messages"]) == 1 + (16 - 8)


def test_a_failure_anywhere_leaves_the_watermark_where_it_was(store, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "2")
    monkeypatch.setenv("CF_CONVERSATION_SUMMARY_SLACK_TURNS", "0")
    _seed_pairs(10)

    async def _boom(*_a: Any, **_k: Any):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(summ, "summarize_with_llm", _boom)
    assert asyncio.run(summ.summarize_conversation(CONVERSATION_ID)) is None
    assert _row()["summary_through_seq"] == 0


# ── MCP stays the only gateway client ───────────────────────────────────────


def test_the_llm_call_goes_through_mcp_invoke(store, monkeypatch):
    posted: dict = {}

    class _Resp:
        def raise_for_status(self): return None
        def json(self):
            return {"data": {"finalResponse": '{"current_goal": "ship the gate"}'}}

    async def _post(_self, url, **kwargs):
        posted["url"] = url
        posted["json"] = kwargs.get("json")
        return _Resp()

    monkeypatch.setattr(summ.httpx.AsyncClient, "post", _post)
    out = asyncio.run(summ.summarize_with_llm([{"role": "user", "content": "hello"}]))

    assert posted["url"].endswith("/mcp/invoke")
    assert out["current_goal"] == "ship the gate"
    # Single-shot, no tools: this is a summarisation, not an agent loop.
    assert posted["json"]["limits"]["maxSteps"] == 1
    assert posted["json"]["tools"] == []


def test_an_unreachable_mcp_still_produces_a_summary(store, no_mcp):
    # The deterministic parser. A crude summary still moves the watermark, which
    # still beats dropping those turns entirely.
    out = asyncio.run(summ.summarize_with_llm([
        {"role": "user", "content": "we decided to use the event bus"},
        {"role": "assistant", "content": "noted"},
    ]))
    assert out["current_goal"]
    assert any("event bus" in item for item in out["decisions_made"])


def test_unparseable_model_output_falls_back(store, monkeypatch):
    class _Resp:
        def raise_for_status(self): return None
        def json(self): return {"data": {"finalResponse": "sorry, I cannot do that"}}

    async def _post(_self, _url, **_kw): return _Resp()

    monkeypatch.setattr(summ.httpx.AsyncClient, "post", _post)
    out = asyncio.run(summ.summarize_with_llm([{"role": "user", "content": "a question?"}]))
    assert out["current_goal"]
    assert set(out) == set(summ.SUMMARY_SCHEMA_KEYS)


def test_a_wild_model_response_is_coerced_into_the_schema(store):
    out = summ.normalize_summary({
        "current_goal": {"not": "a string"},
        "decisions_made": "a bare string where a list belongs",
        "requirements": list(range(500)),
    })
    assert isinstance(out["current_goal"], str)
    assert out["decisions_made"] == ["a bare string where a list belongs"]
    assert len(out["requirements"]) == 20
    assert set(out) == set(summ.SUMMARY_SCHEMA_KEYS)


# ── never on the request path ───────────────────────────────────────────────


def _run_endpoint(req, monkeypatch):
    async def _fake_gateway(**_kwargs):
        return ChatResponse(
            content="the answer", tool_calls=[], finish_reason="stop",
            input_tokens=10, output_tokens=5, latency_ms=1,
            provider="mock", model="mock-1", model_alias="mock-fast", estimated_cost=0.0,
        )

    monkeypatch.setattr(llm_mod, "call_gateway_chat", _fake_gateway)
    monkeypatch.setattr(execute_mod, "emit_audit_event", lambda **k: None)
    return asyncio.new_event_loop().run_until_complete(
        execute_mod.execute_governed_single_turn(req)
    )


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


def test_the_request_path_does_not_wait_for_the_llm(store, summarising, monkeypatch):
    # THE test for this module. A summariser slower than any acceptable response
    # time, and a response that comes back anyway. If schedule() ever starts
    # awaiting, this fails — and every chat surface starts stuttering.
    monkeypatch.setenv("CF_CONVERSATION_WRITE_ENABLED", "true")

    async def _glacial(_conversation_id: str):
        await asyncio.sleep(30)
        return None

    monkeypatch.setattr(summ, "summarize_conversation", _glacial)

    started = time.monotonic()
    out = _run_endpoint(_request(), monkeypatch)
    elapsed = time.monotonic() - started

    assert out["status"] == "COMPLETED"
    assert elapsed < 5.0


def test_the_endpoint_schedules_a_summarisation_after_writing(store, summarising, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_WRITE_ENABLED", "true")
    scheduled: list = []
    monkeypatch.setattr(summ, "schedule", lambda rc, *a, **k: scheduled.append(rc))
    _run_endpoint(_request(), monkeypatch)
    assert len(scheduled) == 1


def test_nothing_is_scheduled_when_nothing_was_written(store, summarising, monkeypatch):
    # Writes off: no new turn, so nothing to summarise.
    monkeypatch.delenv("CF_CONVERSATION_WRITE_ENABLED", raising=False)
    scheduled: list = []
    monkeypatch.setattr(summ, "schedule", lambda rc, *a, **k: scheduled.append(rc))
    _run_endpoint(_request(), monkeypatch)
    assert scheduled == []


def test_a_scheduling_failure_never_reaches_the_caller(store, summarising, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_WRITE_ENABLED", "true")

    def _boom(*_a: Any, **_k: Any):
        raise RuntimeError("scheduler broken")

    monkeypatch.setattr(summ, "resolve_conversation", _boom)
    out = _run_endpoint(_request(), monkeypatch)
    assert out["status"] == "COMPLETED"


def test_schedule_outside_an_event_loop_is_a_no_op(store, summarising):
    # A synchronous caller, or interpreter shutdown. Optional maintenance.
    assert summ.schedule(SYNTHESIS_RC) is None


def test_a_second_schedule_while_one_is_running_does_not_double_call(store, summarising, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "2")
    monkeypatch.setenv("CF_CONVERSATION_SUMMARY_SLACK_TURNS", "0")
    _seed_pairs(10)
    calls: list = []

    async def _slow(messages, conversation_id=None):
        calls.append(conversation_id)
        await asyncio.sleep(0.05)
        return summ.normalize_summary({"current_goal": "done"})

    monkeypatch.setattr(summ, "summarize_with_llm", _slow)

    async def _go():
        return await asyncio.gather(
            summ.summarize_conversation(CONVERSATION_ID),
            summ.summarize_conversation(CONVERSATION_ID),
        )

    asyncio.run(_go())
    assert len(calls) == 1


# ── the whole point ─────────────────────────────────────────────────────────


def test_the_turns_that_used_to_be_dropped_now_survive(store, monkeypatch, no_mcp):
    """Before this module, everything past the verbatim window was lost.

    `build()` reads with `after_seq=summary_through_seq`. With the watermark
    stuck at zero, a turn older than the window was in neither tier — not
    verbatim, not summarised, just gone. Now it comes back as summary.
    """
    monkeypatch.setenv("CF_CONVERSATION_ENABLED", "true")
    monkeypatch.setenv("CF_CONVERSATION_VERBATIM_PAIRS", "2")
    monkeypatch.setenv("CF_CONVERSATION_SUMMARY_SLACK_TURNS", "0")

    cs.append_turn(CONVERSATION_ID, "user", "we decided to use the event bus")
    cs.append_turn(CONVERSATION_ID, "assistant", "recorded that decision")
    _seed_pairs(8, start=2)  # 16 more turns, pushing the decision far out of the window

    # Before summarising: the early decision is simply absent.
    before = asyncio.run(ctx.build(SYNTHESIS_RC))
    assert all("event bus" not in m["content"] for m in before)

    asyncio.run(summ.summarize_conversation(CONVERSATION_ID))

    after = asyncio.run(ctx.build(SYNTHESIS_RC))
    joined = "\n".join(m["content"] for m in after)
    assert "event bus" in joined
    assert "CONVERSATION SUMMARY THROUGH TURN" in joined
    # And the verbatim tail is still there, on top of the summary.
    assert after[-1]["content"] == "answer 9"
