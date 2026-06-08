"""LLM-on-laptop (P-c) — registry serving filter, model-run dispatch, and the
call_gateway_chat laptop branch with cloud fallback.

Uses asyncio.run() wrappers to match the repo's async-test convention.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from context_api_service.app import laptop_registry as lr
from context_api_service.app.governed import llm_client as lc


class _FakeWS:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_text(self, s: str) -> None:
        self.sent.append(s)

    async def close(self, **_kw) -> None:
        pass


def _conn(user: str, device: str, frames: list[str]) -> lr.ActiveConnection:
    return lr.ActiveConnection(
        user_id=user, device_id=device, device_name=device, ws=_FakeWS(),
        connected_at=0.0, last_seen_at=1e18, supported_frame_types=frames,
    )


# ── registry: serving filter ──────────────────────────────────────────────────
def test_any_for_user_serving_filters_by_frame_type():
    async def _run():
        reg = lr.LaptopRegistry()
        await reg.register(_conn("u1", "d1", ["invoke", "tool-run"]))   # tools only
        assert await reg.any_for_user_serving("u1", "model-run") is None
        assert await reg.any_for_user_serving("u1", "tool-run") is not None
        await reg.register(_conn("u1", "d2", ["invoke", "model-run"]))  # serves LLM
        got = await reg.any_for_user_serving("u1", "model-run")
        assert got is not None and got.device_id == "d2"
    asyncio.run(_run())


def test_dispatch_model_raises_when_no_serving_laptop():
    async def _run():
        reg = lr.LaptopRegistry()
        await reg.register(_conn("u1", "d1", ["invoke", "tool-run"]))  # no model-run
        with pytest.raises(lr.LaptopNotConnected):
            await reg.dispatch_model_via_laptop(user_id="u1", request_body={"messages": []})
    asyncio.run(_run())


def test_dispatch_model_round_trip_returns_gateway_payload():
    async def _run():
        reg = lr.LaptopRegistry()
        conn = _conn("u1", "d1", ["invoke", "model-run"])
        await reg.register(conn)
        gateway_shape = {"content": "hi from laptop", "provider": "copilot", "model": "gpt-4o",
                         "finish_reason": "stop", "input_tokens": 3, "output_tokens": 4}

        async def _deliver():
            for _ in range(500):
                if conn.ws.sent:
                    break
                await asyncio.sleep(0.001)
            frame = json.loads(conn.ws.sent[-1])
            assert frame["type"] == "model-run"
            await reg.deliver_response("u1", "d1", frame["request_id"], gateway_shape, None)

        task = asyncio.create_task(_deliver())
        out = await reg.dispatch_model_via_laptop(
            user_id="u1", request_body={"messages": [{"role": "user", "content": "hi"}]})
        await task
        assert out == gateway_shape
    asyncio.run(_run())


# ── llm_client: laptop branch + cloud fallback ────────────────────────────────
def test_try_laptop_chat_parses_gateway_dict(monkeypatch):
    async def _ok(*, user_id, request_body, timeout):
        return {"content": "ok", "provider": "copilot", "model": "gpt-4o",
                "finish_reason": "stop", "input_tokens": 1, "output_tokens": 1}
    monkeypatch.setattr(lr.REGISTRY, "dispatch_model_via_laptop", _ok)
    resp = asyncio.run(lc._try_laptop_chat("u1", {"messages": []}))
    assert resp is not None and resp.content == "ok" and resp.provider == "copilot"


def test_try_laptop_chat_falls_back_when_not_connected(monkeypatch):
    async def _none(*, user_id, request_body, timeout):
        raise lr.LaptopNotConnected("none")
    monkeypatch.setattr(lr.REGISTRY, "dispatch_model_via_laptop", _none)
    assert asyncio.run(lc._try_laptop_chat("u1", {"messages": []})) is None  # → caller uses cloud


def test_try_laptop_chat_surfaces_runner_error(monkeypatch):
    async def _err(*, user_id, request_body, timeout):
        raise lr.LaptopInvokeError(code="X", message="boom")
    monkeypatch.setattr(lr.REGISTRY, "dispatch_model_via_laptop", _err)
    with pytest.raises(lc.LLMGatewayError):
        asyncio.run(lc._try_laptop_chat("u1", {"messages": []}))
