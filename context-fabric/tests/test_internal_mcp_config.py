from __future__ import annotations

import importlib
from pathlib import Path

import httpx
import pytest

from context_api_service.app import internal_mcp


_TIMEOUT_ENVS = (
    "CONTEXT_FABRIC_INTERNAL_MCP_IAM_TIMEOUT_SEC",
    "CONTEXT_FABRIC_SERVER_TOOL_INVOKE_TIMEOUT_SEC",
    "CONTEXT_FABRIC_MCP_RESOURCE_FETCH_TIMEOUT_SEC",
)


@pytest.fixture(autouse=True)
def reset_internal_mcp_module(monkeypatch):
    yield
    for name in _TIMEOUT_ENVS:
        monkeypatch.delenv(name, raising=False)
    importlib.reload(internal_mcp)


def _reload_with_env(monkeypatch, values: dict[str, str | None]):
    for name in _TIMEOUT_ENVS:
        if name in values and values[name] is not None:
            monkeypatch.setenv(name, values[name] or "")
        else:
            monkeypatch.delenv(name, raising=False)
    return importlib.reload(internal_mcp)


def test_internal_mcp_timeout_envs_default_and_fallback(monkeypatch):
    module = _reload_with_env(monkeypatch, {})
    assert module.INTERNAL_MCP_IAM_TIMEOUT_SEC == 10.0
    assert module.SERVER_TOOL_INVOKE_TIMEOUT_SEC == 120.0
    assert module.MCP_RESOURCE_FETCH_TIMEOUT_SEC == 10.0

    module = _reload_with_env(
        monkeypatch,
        {
            "CONTEXT_FABRIC_INTERNAL_MCP_IAM_TIMEOUT_SEC": "bad",
            "CONTEXT_FABRIC_SERVER_TOOL_INVOKE_TIMEOUT_SEC": "0",
            "CONTEXT_FABRIC_MCP_RESOURCE_FETCH_TIMEOUT_SEC": "nan",
        },
    )
    assert module.INTERNAL_MCP_IAM_TIMEOUT_SEC == 10.0
    assert module.SERVER_TOOL_INVOKE_TIMEOUT_SEC == 120.0
    assert module.MCP_RESOURCE_FETCH_TIMEOUT_SEC == 10.0


def test_internal_mcp_timeout_envs_accept_and_clamp(monkeypatch):
    module = _reload_with_env(
        monkeypatch,
        {
            "CONTEXT_FABRIC_INTERNAL_MCP_IAM_TIMEOUT_SEC": "12.5",
            "CONTEXT_FABRIC_SERVER_TOOL_INVOKE_TIMEOUT_SEC": "240.25",
            "CONTEXT_FABRIC_MCP_RESOURCE_FETCH_TIMEOUT_SEC": "18",
        },
    )
    assert module.INTERNAL_MCP_IAM_TIMEOUT_SEC == 12.5
    assert module.SERVER_TOOL_INVOKE_TIMEOUT_SEC == 240.25
    assert module.MCP_RESOURCE_FETCH_TIMEOUT_SEC == 18.0

    module = _reload_with_env(
        monkeypatch,
        {
            "CONTEXT_FABRIC_INTERNAL_MCP_IAM_TIMEOUT_SEC": "9999",
            "CONTEXT_FABRIC_SERVER_TOOL_INVOKE_TIMEOUT_SEC": "9999",
            "CONTEXT_FABRIC_MCP_RESOURCE_FETCH_TIMEOUT_SEC": "9999",
        },
    )
    assert module.INTERNAL_MCP_IAM_TIMEOUT_SEC == 300.0
    assert module.SERVER_TOOL_INVOKE_TIMEOUT_SEC == 3600.0
    assert module.MCP_RESOURCE_FETCH_TIMEOUT_SEC == 300.0


class FakeAsyncClient:
    responses: list[httpx.Response] = []
    calls: list[tuple[str, str]] = []
    timeouts: list[float] = []

    def __init__(self, timeout: float):
        self.timeout = timeout
        self.timeouts.append(timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url: str, **kwargs):
        self.calls.append(("GET", url))
        if not self.responses:
            raise AssertionError(f"unexpected GET {url}")
        return self.responses.pop(0)


@pytest.mark.asyncio
async def test_internal_mcp_iam_get_uses_bounded_default_timeout(monkeypatch):
    module = _reload_with_env(
        monkeypatch,
        {"CONTEXT_FABRIC_INTERNAL_MCP_IAM_TIMEOUT_SEC": "12.5"},
    )

    async def fake_token():
        return "service.jwt"

    FakeAsyncClient.responses = [httpx.Response(200, json={"ok": True})]
    FakeAsyncClient.calls = []
    FakeAsyncClient.timeouts = []
    monkeypatch.setattr(module, "get_iam_service_token", fake_token)
    monkeypatch.setattr(module.httpx, "AsyncClient", FakeAsyncClient)

    response = await module._iam_get("http://iam.local/mcp-servers/server-1")

    assert response.status_code == 200
    assert FakeAsyncClient.calls == [("GET", "http://iam.local/mcp-servers/server-1")]
    assert FakeAsyncClient.timeouts == [12.5]


def test_internal_mcp_outbound_calls_use_bounded_timeout_constants():
    source = Path("services/context_api_service/app/internal_mcp.py").read_text()
    assert "from .env_config import bounded_float_env" in source
    assert "CONTEXT_FABRIC_INTERNAL_MCP_IAM_TIMEOUT_SEC" in source
    assert "CONTEXT_FABRIC_SERVER_TOOL_INVOKE_TIMEOUT_SEC" in source
    assert "CONTEXT_FABRIC_MCP_RESOURCE_FETCH_TIMEOUT_SEC" in source
    assert "httpx.AsyncClient(timeout=SERVER_TOOL_INVOKE_TIMEOUT_SEC)" in source
    assert source.count("httpx.AsyncClient(timeout=MCP_RESOURCE_FETCH_TIMEOUT_SEC)") == 2
    assert "httpx.AsyncClient(timeout=120.0)" not in source
    assert "httpx.AsyncClient(timeout=10.0)" not in source
    assert "timeout=10.0" not in source
