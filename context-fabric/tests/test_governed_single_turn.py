"""Governed single-turn endpoint (/api/v1/execute-governed-turn).

One LLM turn with the caller's prompt VERBATIM (no phase machine, no per-phase
re-assembly) + governed audit + 'governed' posture. For single-shot callers
(prompt-composer compose-and-respond, contracts replay, event-horizon chat).
"""
import asyncio
from uuid import UUID

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
    out = asyncio.new_event_loop().run_until_complete(execute_mod.execute_governed_single_turn(req))
    return out, captured


def test_uses_caller_prompt_verbatim_and_reports_governed(monkeypatch):
    req = execute_mod.GovernedSingleTurnRequest(
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


def test_forwards_frozen_model_resolution_as_gateway_expectation(monkeypatch):
    req = execute_mod.GovernedSingleTurnRequest(
        trace_id="t-model",
        task="replay",
        system_prompt="frozen",
        model_overrides={
            "modelAlias": "balanced",
            "provider": "anthropic",
            "model": "claude-sonnet-4-5-20251001",
        },
    )
    _out, captured = _run_turn(req, monkeypatch)
    assert captured["model_alias"] == "balanced"
    assert captured["expected_provider"] == "anthropic"
    assert captured["expected_model"] == "claude-sonnet-4-5-20251001"


def test_no_system_prompt_sends_only_user_message(monkeypatch):
    req = execute_mod.GovernedSingleTurnRequest(trace_id="t2", task="hi", system_prompt="")
    _out, captured = _run_turn(req, monkeypatch)
    assert captured["messages"] == [{"role": "user", "content": "hi"}]


def test_missing_trace_gets_generated_uuid(monkeypatch):
    req = execute_mod.GovernedSingleTurnRequest(task="hi", system_prompt="")
    out, _ = _run_turn(req, monkeypatch)
    UUID(out["correlation"]["traceId"])
    assert out["correlation"]["traceIdGenerated"] is True


def test_token_usage_rolled_up(monkeypatch):
    req = execute_mod.GovernedSingleTurnRequest(trace_id="t3", task="x", system_prompt="y")
    out, _ = _run_turn(req, monkeypatch)
    assert out["tokensUsed"] == {"input": 10, "output": 5, "total": 15}
    assert out["modelUsage"]["provider"] == "mock"


def test_governance_mode_reported_from_request(monkeypatch):
    req = execute_mod.GovernedSingleTurnRequest(
        trace_id="t4",
        task="x",
        system_prompt="y",
        governanceMode="fail_closed",
    )
    out, _ = _run_turn(req, monkeypatch)
    assert out["correlation"]["governanceMode"] == "fail_closed"


def test_invalid_governance_mode_falls_back_to_deployment_default(monkeypatch):
    monkeypatch.setattr(execute_mod.settings, "default_governance_mode", "fail_closed")
    req = execute_mod.GovernedSingleTurnRequest(
        trace_id="t5",
        task="x",
        system_prompt="y",
        governanceMode="definitely-not-a-mode",
    )
    out, _ = _run_turn(req, monkeypatch)
    assert out["correlation"]["governanceMode"] == "fail_closed"


# ── HTTP-level routing tests ────────────────────────────────────────────────
# Regression guard for the duplicate-route bug: a direct function call can't
# catch two @router.post handlers sharing a path, so post real JSON through the
# ASGI router. /execute-governed-single-turn (verbatim) must be DISTINCT from the
# older /execute-governed-turn (phase-machine, requires stage_key).
def _client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from context_api_service.app.execute import router

    async def _fake_gateway(**kwargs):
        return _fake()

    monkeypatch.setattr(llm_mod, "call_gateway_chat", _fake_gateway)
    monkeypatch.setattr(execute_mod, "emit_audit_event", lambda **k: None)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


def test_http_single_turn_route_accepts_verbatim_body(monkeypatch):
    c = _client(monkeypatch)
    r = c.post("/api/v1/execute-governed-single-turn",
               json={"trace_id": "t", "task": "hi", "system_prompt": "sys"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["finalResponse"] == "the answer"
    assert body["correlation"]["executionPosture"] == "governed"


def test_http_verbatim_body_does_not_hit_phase_turn_route(monkeypatch):
    # The OLD phase-machine route requires stage_key — a verbatim body must be
    # rejected there (422), proving the two routes/models are not conflated.
    c = _client(monkeypatch)
    r = c.post("/api/v1/execute-governed-turn",
               json={"trace_id": "t", "task": "hi", "system_prompt": "sys"})
    assert r.status_code == 422, r.text
