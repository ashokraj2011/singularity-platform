"""
Conversation write — the half that finally puts something in the store.

Until this path existed the read side was reading a table nothing filled, so
"memory" was structurally guaranteed to be empty. These tests pin the four
properties that make writing safe to switch on:

  1. IT SHIPS DARK TOO. `CF_CONVERSATION_WRITE_ENABLED` defaults false, and with
     it off no call site touches the store at all.

  2. WRITES AND READS ARE INDEPENDENT. Writing on with reading off is the
     warming state — history accumulates and not one model output changes.

  3. TOOL TRAFFIC CANNOT BE PERSISTED. The store refuses non-user/assistant
     roles; what is proved here is stronger — that the call sites never even
     offer it, including on stages whose turns are almost entirely tool calls.

  4. A WRITE NEVER FAILS A TURN. It runs after the model has already answered,
     so a broken store must cost the conversation its memory and cost the
     caller nothing.

Conventions match the rest of context-fabric/tests/: no pytest-asyncio, drive
coroutines with asyncio.run(), real SQLite per test, patch names on the
importing module.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import patch

import pytest

from context_api_service.app import conversation_store as cs
from context_api_service.app import execute as execute_mod
from context_api_service.app.governed import conversation_context as ctx
from context_api_service.app.governed import llm_client as llm_mod
from context_api_service.app.governed import stage_driver
from context_api_service.app.governed.llm_client import ChatResponse
from context_api_service.app.governed.loop import GovernedStepResult
from context_api_service.app.governed.phase_state import Phase, PhaseState
from context_api_service.app.governed.policy_loader import PolicyNotFoundError
from context_api_service.app.governed.turn import TurnResult


SYNTHESIS_RC = {
    "surface": "synthesis",
    "thread_id": "t1",
    "capability_id": "cap1",
    "tenant_id": "acme",
    "user_id": "u-1",
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
    cs.refresh_db_target()
    cs.init_db()
    return cs


@pytest.fixture()
def writing(monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_WRITE_ENABLED", "true")


def _turns(conversation_id: str = CONVERSATION_ID) -> list[tuple[str, str]]:
    """Every stored turn as (role, content), oldest first."""
    return [
        (row["role"], row["content"])
        for row in cs.turns_through(conversation_id, 10_000)
    ]


def _record(*args, **kwargs):
    return asyncio.run(ctx.record_turn(*args, **kwargs))


# ── the write gate ──────────────────────────────────────────────────────────


def test_writing_is_off_by_default(store):
    assert ctx.is_write_enabled() is False
    assert _record(SYNTHESIS_RC, user_text="q", assistant_text="a") == 0
    assert _turns() == []


def test_the_gate_is_checked_before_any_io(store, monkeypatch):
    def _explode(*_a, **_k):
        raise AssertionError("the store must not be written while the flag is off")

    monkeypatch.setattr(cs, "ensure_conversation", _explode)
    assert _record(SYNTHESIS_RC, user_text="q", assistant_text="a") == 0


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
def test_truthy_values_enable_writing(store, monkeypatch, value):
    monkeypatch.setenv("CF_CONVERSATION_WRITE_ENABLED", value)
    assert ctx.is_write_enabled() is True


@pytest.mark.parametrize("value", ["", "0", "false", "no", "off", "maybe"])
def test_everything_else_leaves_writing_dark(store, monkeypatch, value):
    monkeypatch.setenv("CF_CONVERSATION_WRITE_ENABLED", value)
    assert ctx.is_write_enabled() is False


def test_writing_does_not_require_the_read_flag(store, writing, monkeypatch):
    # THE warming state: accumulate history while every model output stays
    # byte-identical to today's. This is why there are two flags and not one.
    monkeypatch.delenv("CF_CONVERSATION_ENABLED", raising=False)
    assert _record(SYNTHESIS_RC, user_text="q", assistant_text="a") == 2
    assert ctx.is_enabled() is False
    assert asyncio.run(ctx.build(SYNTHESIS_RC)) == []


def test_the_read_allowlist_does_not_gate_writes(store, writing, monkeypatch):
    # CF_CONVERSATION_SURFACES narrows who READS. Warming a surface you have not
    # enabled reads for yet is the entire point.
    monkeypatch.setenv("CF_CONVERSATION_SURFACES", "room_copilot")
    assert _record(SYNTHESIS_RC, user_text="q", assistant_text="a") == 2


# ── what gets written ───────────────────────────────────────────────────────


def test_a_completed_exchange_is_stored_user_first(store, writing):
    assert _record(SYNTHESIS_RC, user_text="what did we decide?", assistant_text="the gate") == 2
    assert _turns() == [("user", "what did we decide?"), ("assistant", "the gate")]


def test_the_conversation_row_carries_the_identity(store, writing):
    _record(SYNTHESIS_RC, user_text="q", assistant_text="a")
    row = cs.get_conversation(CONVERSATION_ID)
    assert row["surface"] == "synthesis"
    assert row["scope_kind"] == "thread"
    assert row["scope_id"] == "t1"
    assert row["tenant_id"] == "acme"
    assert row["capability_id"] == "cap1"


def test_successive_exchanges_accumulate_in_order(store, writing):
    _record(SYNTHESIS_RC, user_text="first", assistant_text="one")
    _record(SYNTHESIS_RC, user_text="second", assistant_text="two")
    assert _turns() == [
        ("user", "first"), ("assistant", "one"),
        ("user", "second"), ("assistant", "two"),
    ]


def test_what_was_written_is_what_comes_back(store, writing, monkeypatch):
    # The round trip. Before this PR the read path had nothing to read.
    monkeypatch.setenv("CF_CONVERSATION_ENABLED", "true")
    _record(SYNTHESIS_RC, user_text="we chose the event bus", assistant_text="noted")
    prelude = asyncio.run(ctx.build(SYNTHESIS_RC))
    assert [(m["role"], m["content"]) for m in prelude] == [
        ("user", "we chose the event bus"),
        ("assistant", "noted"),
    ]


@pytest.mark.parametrize(
    "user_text,assistant_text",
    [("", "an answer"), ("a question", ""), ("   ", "an answer"), ("a question", "   "),
     (None, "an answer"), ("a question", None)],
)
def test_a_half_exchange_is_never_stored(store, writing, user_text, assistant_text):
    # Replaying a question the assistant never answered would teach the model
    # that it ignores users. Both halves land together or neither does.
    assert _record(SYNTHESIS_RC, user_text=user_text, assistant_text=assistant_text) == 0
    assert _turns() == []


def test_a_stateless_surface_is_never_stored(store, writing):
    # The one-shot extractors. Giving them memory would leak one document's
    # analysis into the next — a correctness regression, not a feature.
    assert _record({"surface": "spec_generation"}, user_text="q", assistant_text="a") == 0
    assert _record(None, user_text="q", assistant_text="a") == 0


def test_a_broken_store_is_swallowed(store, writing, monkeypatch):
    monkeypatch.setattr(
        cs, "append_turn",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("down")),
    )
    assert _record(SYNTHESIS_RC, user_text="q", assistant_text="a") == 0


def test_a_hanging_store_gives_up_rather_than_blocking(store, writing, monkeypatch):
    import time

    monkeypatch.setenv("CF_CONVERSATION_WRITE_TIMEOUT_SEC", "0.05")
    monkeypatch.setattr(cs, "ensure_conversation", lambda *_a, **_k: time.sleep(1.0))
    assert _record(SYNTHESIS_RC, user_text="q", assistant_text="a") == 0


# ── tool traffic is unrepresentable ─────────────────────────────────────────


def test_record_turn_has_no_parameter_that_could_carry_tool_traffic(store):
    # The strongest form of the guarantee: not "the store rejects it" but "the
    # call sites cannot express it". Only two content parameters exist.
    import inspect

    params = inspect.signature(ctx.record_turn).parameters
    content_params = {"user_text", "assistant_text"}
    assert content_params <= set(params)
    for name in params:
        assert "tool" not in name.lower()


def _roles_offered_to_the_store(monkeypatch) -> list[str]:
    """Record every role the call sites hand to append_turn."""
    seen: list[str] = []
    real = cs.append_turn

    def _spy(conversation_id, role, content, **kw):
        seen.append(role)
        return real(conversation_id, role, content, **kw)

    monkeypatch.setattr(cs, "append_turn", _spy)
    return seen


# ── the single-turn endpoint ────────────────────────────────────────────────


def _run_endpoint(req, monkeypatch, *, content: str = "the answer", fail: bool = False):
    async def _fake_gateway(**_kwargs):
        if fail:
            raise llm_mod.LLMGatewayError("LLM_GATEWAY_TIMEOUT", "gateway down")
        return ChatResponse(
            content=content, tool_calls=[], finish_reason="stop",
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


def test_endpoint_writes_nothing_with_the_flag_off(store, monkeypatch):
    out = _run_endpoint(_request(), monkeypatch)
    assert out["status"] == "COMPLETED"
    assert _turns() == []


def test_endpoint_records_the_exchange_when_writing(store, writing, monkeypatch):
    _run_endpoint(_request(), monkeypatch)
    assert _turns() == [("user", "what did we decide?"), ("assistant", "the answer")]


def test_endpoint_stores_the_raw_task_not_the_composed_prompt(store, writing, monkeypatch):
    # `messages` by this point may carry the system prompt and, on the composed
    # path, the platform's own grounding layers. Persisting those would feed the
    # platform's scaffolding back next turn wearing the user's voice.
    _run_endpoint(_request(), monkeypatch)
    stored_user = [content for role, content in _turns() if role == "user"]
    assert stored_user == ["what did we decide?"]
    assert "You are precise." not in "\n".join(stored_user)


def test_endpoint_writes_nothing_when_the_llm_fails(store, writing, monkeypatch):
    # A failed turn must leave the conversation exactly as it was, not stranded
    # holding an unanswered question.
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        _run_endpoint(_request(), monkeypatch, fail=True)
    assert _turns() == []


def test_endpoint_only_ever_offers_user_and_assistant_roles(store, writing, monkeypatch):
    seen = _roles_offered_to_the_store(monkeypatch)
    _run_endpoint(_request(), monkeypatch)
    assert seen == ["user", "assistant"]


def test_endpoint_still_answers_when_the_write_explodes(store, writing, monkeypatch):
    monkeypatch.setattr(
        cs, "ensure_conversation",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("down")),
    )
    out = _run_endpoint(_request(), monkeypatch)
    assert out["status"] == "COMPLETED"
    assert out["finalResponse"] == "the answer"


def test_endpoint_on_a_stateless_surface_writes_nothing(store, writing, monkeypatch):
    out = _run_endpoint(_request(run_context={"surface": "spec_generation"}), monkeypatch)
    assert out["status"] == "COMPLETED"
    assert _turns() == []


# ── the governed stage loop ─────────────────────────────────────────────────


def _state(phase: Phase = Phase.PLAN) -> PhaseState:
    return PhaseState(
        stage_key="develop", agent_role="DEVELOPER",
        current_phase=phase, produced_code_changes={},
    )


def _turn(to_phase: Phase, content: str, *, advanced: bool = True) -> TurnResult:
    next_state = _state(to_phase)
    step = GovernedStepResult(
        next_state=next_state, from_phase="PLAN", to_phase=to_phase.value,
        phase_advanced=advanced, tool_outcomes=[], validation_error=None,
    )
    return TurnResult(
        next_state=next_state, step=step,
        llm={"content": content}, prompt={}, policy={},
    )


def _drive_stage(script: list[TurnResult], **kwargs: Any):
    seq = iter(script)

    async def _fake_run_turn(**_kw: Any) -> TurnResult:
        return next(seq)

    async def _fake_emit(*_a: Any, **_k: Any) -> None:
        return None

    async def _no_policy(*_a: Any, **_k: Any):
        raise PolicyNotFoundError("no policy in test")

    async def _go():
        with patch.object(stage_driver, "run_turn", new=_fake_run_turn), \
             patch.object(stage_driver, "emit_governed_event", new=_fake_emit), \
             patch.object(stage_driver, "load_stage_policy", new=_no_policy):
            return await stage_driver.run_stage(
                state=_state(),
                stage_key="develop",
                agent_role="DEVELOPER",
                max_turns=kwargs.pop("max_turns", 25),
                **kwargs,
            )

    return asyncio.run(_go())


STAGE_RC = dict(SYNTHESIS_RC)


def test_stage_writes_nothing_with_the_flag_off(store, monkeypatch):
    _drive_stage(
        [_turn(Phase.FINALIZE, "the design is settled")],
        run_context=dict(STAGE_RC), vars={"task": "design the bus"},
    )
    assert _turns() == []


def test_stage_records_the_task_and_its_final_text(store, writing):
    _drive_stage(
        [_turn(Phase.FINALIZE, "the design is settled")],
        run_context=dict(STAGE_RC), vars={"task": "design the bus"},
    )
    assert _turns() == [("user", "design the bus"), ("assistant", "the design is settled")]


def test_a_long_stage_writes_one_exchange_not_one_per_turn(store, writing):
    # THE reason the write sits outside the loop. A 6-turn stage stores 2 rows.
    script = [
        _turn(Phase.EXPLORE, "looking around"),
        _turn(Phase.ACT, "editing"),
        _turn(Phase.VERIFY, "checking"),
        _turn(Phase.REPAIR, "fixing"),
        _turn(Phase.SELF_REVIEW, "reviewing"),
        _turn(Phase.FINALIZE, "done: shipped the gate"),
    ]
    result = _drive_stage(script, run_context=dict(STAGE_RC), vars={"task": "ship the gate"})
    assert len(result.turns) == 6
    assert _turns() == [("user", "ship the gate"), ("assistant", "done: shipped the gate")]


def test_stage_falls_back_to_the_last_turn_that_actually_said_something(store, writing):
    # The final turn of a stage is routinely a pure tool call with empty content;
    # the substantive answer is a turn or two earlier.
    script = [
        _turn(Phase.ACT, "here is the plan in full"),
        _turn(Phase.FINALIZE, ""),
    ]
    _drive_stage(script, run_context=dict(STAGE_RC), vars={"task": "plan it"})
    assert _turns() == [("user", "plan it"), ("assistant", "here is the plan in full")]


def test_a_stage_that_never_spoke_writes_nothing(store, writing):
    _drive_stage(
        [_turn(Phase.FINALIZE, "")],
        run_context=dict(STAGE_RC), vars={"task": "plan it"},
    )
    assert _turns() == []


def test_a_stage_with_no_task_text_writes_nothing(store, writing):
    _drive_stage(
        [_turn(Phase.FINALIZE, "something happened")],
        run_context={"surface": "synthesis", "thread_id": "t1"}, vars={},
    )
    assert _turns() == []


def test_stage_reads_the_task_from_run_context_when_vars_has_none(store, writing):
    # The /execute-governed-stage route has no top-level task; the workflow
    # AGENT_TASK path passes it through run_context instead.
    rc = dict(STAGE_RC)
    rc["task"] = "task from run_context"
    _drive_stage([_turn(Phase.FINALIZE, "ok")], run_context=rc, vars={})
    assert _turns() == [("user", "task from run_context"), ("assistant", "ok")]


def test_stage_only_ever_offers_user_and_assistant_roles(store, writing, monkeypatch):
    # A governed stage's turns are mostly tool traffic. None of it may reach the
    # store, on any of the loop's ~20 terminal exits.
    seen = _roles_offered_to_the_store(monkeypatch)
    _drive_stage(
        [_turn(Phase.ACT, "calling tools"), _turn(Phase.FINALIZE, "done")],
        run_context=dict(STAGE_RC), vars={"task": "do it"},
    )
    assert seen == ["user", "assistant"]


def test_a_broken_store_does_not_fail_the_stage(store, writing, monkeypatch):
    monkeypatch.setattr(
        cs, "ensure_conversation",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("down")),
    )
    result = _drive_stage(
        [_turn(Phase.FINALIZE, "done")],
        run_context=dict(STAGE_RC), vars={"task": "do it"},
    )
    assert result.stop_reason == "FINALIZED"


def test_a_stage_on_a_stateless_surface_writes_nothing(store, writing):
    _drive_stage(
        [_turn(Phase.FINALIZE, "done")],
        run_context={"surface": "spec_generation"}, vars={"task": "extract it"},
    )
    assert _turns() == []
