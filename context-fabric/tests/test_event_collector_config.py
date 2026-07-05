from __future__ import annotations

import asyncio
from pathlib import Path

import httpx

from context_api_service.app.execute_modules import event_collector


def test_mcp_event_drain_timeout_env_is_bounded(monkeypatch):
    monkeypatch.delenv("CONTEXT_FABRIC_MCP_EVENT_DRAIN_TIMEOUT_SEC", raising=False)
    assert event_collector.mcp_event_drain_timeout_sec() == 15.0

    monkeypatch.setenv("CONTEXT_FABRIC_MCP_EVENT_DRAIN_TIMEOUT_SEC", "bad")
    assert event_collector.mcp_event_drain_timeout_sec() == 15.0

    monkeypatch.setenv("CONTEXT_FABRIC_MCP_EVENT_DRAIN_TIMEOUT_SEC", "nan")
    assert event_collector.mcp_event_drain_timeout_sec() == 15.0

    monkeypatch.setenv("CONTEXT_FABRIC_MCP_EVENT_DRAIN_TIMEOUT_SEC", "0")
    assert event_collector.mcp_event_drain_timeout_sec() == 15.0

    monkeypatch.setenv("CONTEXT_FABRIC_MCP_EVENT_DRAIN_TIMEOUT_SEC", "12.5")
    assert event_collector.mcp_event_drain_timeout_sec() == 12.5

    monkeypatch.setenv("CONTEXT_FABRIC_MCP_EVENT_DRAIN_TIMEOUT_SEC", "999999")
    assert event_collector.mcp_event_drain_timeout_sec() == 300.0


class FakeAsyncClient:
    responses: list[httpx.Response] = []
    calls: list[tuple[str, dict | None, dict | None]] = []
    timeouts: list[float] = []

    def __init__(self, timeout: float):
        self.timeouts.append(timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url: str, **kwargs):
        self.calls.append((url, kwargs.get("params"), kwargs.get("headers")))
        if not self.responses:
            raise AssertionError(f"unexpected GET {url}")
        return self.responses.pop(0)


def test_drain_mcp_events_uses_configured_timeout_and_persists_chronological(monkeypatch):
    persisted: list[dict] = []

    def fake_upsert_many(items: list[dict]) -> int:
        persisted.extend(items)
        return len(items)

    request = httpx.Request(
        "GET",
        "http://mcp.local/mcp/events",
        params={"trace_id": "trace-1", "limit": 1000},
    )
    FakeAsyncClient.responses = [
        httpx.Response(
            200,
            json={
                "data": {
                    "items": [
                        {"id": "event-2", "ts": 2},
                        {"id": "event-1", "ts": 1},
                    ]
                }
            },
            request=request,
        )
    ]
    FakeAsyncClient.calls = []
    FakeAsyncClient.timeouts = []
    monkeypatch.setenv("CONTEXT_FABRIC_MCP_EVENT_DRAIN_TIMEOUT_SEC", "12.5")
    monkeypatch.setattr(event_collector.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(event_collector.events_store, "upsert_many", fake_upsert_many)

    count = asyncio.run(event_collector.drain_mcp_events("http://mcp.local/", "bearer-token", "trace-1"))

    assert count == 2
    assert FakeAsyncClient.timeouts == [12.5]
    assert FakeAsyncClient.calls == [
        (
            "http://mcp.local/mcp/events",
            {"trace_id": "trace-1", "limit": 1000},
            {"Authorization": "Bearer bearer-token"},
        )
    ]
    assert persisted == [
        {"id": "event-1", "ts": 1},
        {"id": "event-2", "ts": 2},
    ]


def test_event_collector_uses_bounded_timeout_constant():
    source = Path("services/context_api_service/app/execute_modules/event_collector.py").read_text()
    assert "from ..env_config import bounded_float_value" in source
    assert "CONTEXT_FABRIC_MCP_EVENT_DRAIN_TIMEOUT_SEC" in source
    assert "httpx.AsyncClient(timeout=mcp_event_drain_timeout_sec())" in source
    assert "httpx.AsyncClient(timeout=15.0)" not in source
