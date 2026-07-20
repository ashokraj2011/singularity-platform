"""
The second call site: conversation memory reaching the governed STAGE loop.

`initial_history` has been plumbed through four layers of run_stage and
hardcoded to `[]` at its only caller since it was added. This is what finally
puts something in front of it.

What is being pinned here:

  - with the flag off the history run_turn receives is exactly what it received
    before — the flag-off path is a no-op at this call site too
  - with the flag on, conversation memory leads the history, ahead of both the
    eval feedback and anything the caller passed, because it is the oldest
    context in the list
  - the injected messages carry the `_cf_prelude` marker into the loop, which is
    what stops compress_history breadcrumbing them away mid-stage

Conventions match the rest of context-fabric/tests/: no pytest-asyncio, drive
coroutines with asyncio.run(), patch names on the importing module.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import patch

import pytest

from context_api_service.app import conversation_store as cs
from context_api_service.app.governed import stage_driver
from context_api_service.app.governed.conversation_budget import CF_PRELUDE_KEY
from context_api_service.app.governed.loop import GovernedStepResult
from context_api_service.app.governed.phase_state import Phase, PhaseState
from context_api_service.app.governed.policy_loader import PolicyNotFoundError
from context_api_service.app.governed.turn import TurnResult


RUN_CONTEXT = {"surface": "synthesis", "thread_id": "t1", "capability_id": "cap1"}
CONVERSATION_ID = "sy:thread:t1"


@pytest.fixture()
def store(tmp_path, monkeypatch):
    db = tmp_path / "conversations.db"
    monkeypatch.setenv("CONVERSATION_STORE_DB", str(db))
    monkeypatch.delenv("CONVERSATION_STORE_DATABASE_URL", raising=False)
    monkeypatch.delenv("CONTEXT_FABRIC_DATABASE_URL", raising=False)
    monkeypatch.delenv("CF_CONVERSATION_SURFACES", raising=False)
    cs.refresh_db_target()
    cs.init_db()
    cs.ensure_conversation(CONVERSATION_ID, surface="synthesis")
    cs.append_turn(CONVERSATION_ID, "user", "what did DESIGN conclude?")
    cs.append_turn(CONVERSATION_ID, "assistant", "it settled on the event bus")
    return cs


def _finalize_turn() -> TurnResult:
    """One turn that lands in FINALIZE, so the stage halts immediately."""
    next_state = PhaseState(
        stage_key="develop", agent_role="DEVELOPER",
        current_phase=Phase.FINALIZE, produced_code_changes={},
    )
    step = GovernedStepResult(
        next_state=next_state, from_phase="PLAN", to_phase="FINALIZE",
        phase_advanced=True, tool_outcomes=[], validation_error=None,
    )
    return TurnResult(next_state=next_state, step=step, llm={}, prompt={}, policy={})


def _drive(**run_stage_kwargs: Any) -> list[dict[str, Any]]:
    """Run the REAL run_stage for one turn and return the history run_turn saw."""
    seen: dict[str, Any] = {}

    async def _fake_run_turn(**kw: Any) -> TurnResult:
        seen["history"] = list(kw.get("history") or [])
        return _finalize_turn()

    async def _fake_emit(*_a: Any, **_k: Any) -> None:
        return None

    async def _no_policy(*_a: Any, **_k: Any):
        raise PolicyNotFoundError("no policy in test")

    async def _go():
        with patch.object(stage_driver, "run_turn", new=_fake_run_turn), \
             patch.object(stage_driver, "emit_governed_event", new=_fake_emit), \
             patch.object(stage_driver, "load_stage_policy", new=_no_policy):
            return await stage_driver.run_stage(
                state=PhaseState(
                    stage_key="develop", agent_role="DEVELOPER",
                    current_phase=Phase.PLAN, produced_code_changes={},
                ),
                stage_key="develop",
                agent_role="DEVELOPER",
                max_turns=1,
                **run_stage_kwargs,
            )

    asyncio.run(_go())
    return seen["history"]


def test_flag_off_leaves_the_stage_history_untouched(store, monkeypatch):
    monkeypatch.delenv("CF_CONVERSATION_ENABLED", raising=False)
    assert _drive(run_context=dict(RUN_CONTEXT)) == []


def test_flag_off_preserves_caller_initial_history_exactly(store, monkeypatch):
    monkeypatch.delenv("CF_CONVERSATION_ENABLED", raising=False)
    initial = [{"role": "user", "content": "caller context"}]
    assert _drive(run_context=dict(RUN_CONTEXT), initial_history=initial) == initial


def test_enabled_puts_conversation_memory_at_the_head(store, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_ENABLED", "true")
    history = _drive(run_context=dict(RUN_CONTEXT))
    assert [m["content"] for m in history] == [
        "what did DESIGN conclude?",
        "it settled on the event bus",
    ]
    assert all(m[CF_PRELUDE_KEY] is True for m in history)


def test_conversation_memory_leads_feedback_and_caller_history(store, monkeypatch):
    # Oldest first: the conversation, then the feedback about the attempt that
    # just failed, then whatever the caller handed in.
    monkeypatch.setenv("CF_CONVERSATION_ENABLED", "true")
    history = _drive(
        run_context=dict(RUN_CONTEXT),
        initial_history=[{"role": "user", "content": "caller context"}],
        vars={"eval_feedback": {
            "eval_run_id": "er-1", "status": "FAILED", "pass_rate": 0.4,
            "failing_results": [
                {"evaluator_kind": "llm_judge", "score": 2, "reason": "missed the null case"},
            ],
        }},
    )
    assert [m.get(CF_PRELUDE_KEY, False) for m in history] == [True, True, False, False]
    assert history[2]["content"].startswith("[QUALITY-GATE FEEDBACK]")
    assert history[3]["content"] == "caller context"


def test_a_stage_with_no_conversation_is_unchanged_even_when_enabled(store, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_ENABLED", "true")
    # A one-shot extractor surface: no conversation, so no memory. By design.
    assert _drive(run_context={"surface": "spec_generation"}) == []
    assert _drive(run_context=None) == []


def test_a_broken_store_does_not_stop_the_stage(store, monkeypatch):
    monkeypatch.setenv("CF_CONVERSATION_ENABLED", "true")
    monkeypatch.setattr(cs, "get_conversation", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("down")))
    assert _drive(run_context=dict(RUN_CONTEXT)) == []
