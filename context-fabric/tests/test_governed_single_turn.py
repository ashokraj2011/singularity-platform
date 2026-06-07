"""Governed single-turn endpoint (/api/v1/execute-governed-turn).

One LLM turn with the caller's prompt VERBATIM (no phase machine, no per-phase
re-assembly) + governed audit + 'governed' posture. For single-shot callers
(prompt-composer compose-and-respond, contracts replay, event-horizon chat).
"""
import asyncio

from context_api_service.app import execute as execute_mod
from context_api_service.app.governed import llm_client as llm_mod
from context_api_service.app.governed.llm_client import ChatResponse


def _fake(content: str = "the answer") -> ChatResponse:
    return ChatResponse(
        content=content, tool_calls=[], finish_reason="stop",
        input_tokens=10, output_tokens=5, latency_ms=42,
        provider="mock", model="mock-1", model_alias="mock-fast",
        estimated_cost=0.0,
    )


def _run_turn(req, monkeypatch, resp=None):
    captured: dict = {}

    async def _fake_gateway(**kwargs):
        captured.update(kwargs)
        return resp or _fake()

    monkeypatch.setattr(llm_mod, "call_gateway_chat", _fake_gateway)
    monkeypatch.setattr(execute_mod, "emit_audit_event", lambda **k: None)
    out = asyncio.new_event_loop().run_until_complete(execute_mod.execute_governed_turn(req))
    return out, captured


def test_uses_caller_prompt_verbatim_and_reports_governed(monkeypatch):
    req = execute_mod.GovernedTurnRequest(
        trace_id="t1",
        task="what is 2+2?",
        system_prompt="You are precise.",
        run_context={"capability_id": "cap1"},
        model_overrides={"modelAlias": "mock-fast", "maxOutputTokens": 50},
    )
    out, captured = _run_turn(req, monkeypatch)
    assert out["status"] == "COMPLETED"
    assert out["finalResponse"] == "the answer"
    assert out["correlation"]["executionPosture"] == "governed"
    # The caller's prompt is used verbatim — no re-assembly.
    assert captured["messages"][0] == {"role": "system", "content": "You are precise."}
    assert captured["messages"][-1] == {"role": "user", "content": "what is 2+2?"}
    assert captured["model_alias"] == "mock-fast"
    assert captured["max_output_tokens"] == 50


def test_no_system_prompt_sends_only_user_message(monkeypatch):
    req = execute_mod.GovernedTurnRequest(trace_id="t2", task="hi", system_prompt="")
    _out, captured = _run_turn(req, monkeypatch)
    assert captured["messages"] == [{"role": "user", "content": "hi"}]


def test_token_usage_rolled_up(monkeypatch):
    req = execute_mod.GovernedTurnRequest(trace_id="t3", task="x", system_prompt="y")
    out, _ = _run_turn(req, monkeypatch)
    assert out["tokensUsed"] == {"input": 10, "output": 5, "total": 15}
    assert out["modelUsage"]["provider"] == "mock"
