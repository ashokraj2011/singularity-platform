from __future__ import annotations

import importlib
from pathlib import Path

import httpx
import pytest

from context_api_service.app.execute_modules import runtime_resolver


ENV_NAME = "CONTEXT_FABRIC_RUNTIME_RESOLVER_IAM_TIMEOUT_SEC"


@pytest.fixture(autouse=True)
def reset_runtime_resolver_module(monkeypatch):
    yield
    monkeypatch.delenv(ENV_NAME, raising=False)
    importlib.reload(runtime_resolver)


def _reload_with_timeout(monkeypatch, value: str | None):
    if value is None:
        monkeypatch.delenv(ENV_NAME, raising=False)
    else:
        monkeypatch.setenv(ENV_NAME, value)
    return importlib.reload(runtime_resolver)


def test_runtime_resolver_iam_timeout_is_bounded_env(monkeypatch):
    assert _reload_with_timeout(monkeypatch, None).RUNTIME_RESOLVER_IAM_TIMEOUT_SEC == 10.0
    assert _reload_with_timeout(monkeypatch, "bad").RUNTIME_RESOLVER_IAM_TIMEOUT_SEC == 10.0
    assert _reload_with_timeout(monkeypatch, "0").RUNTIME_RESOLVER_IAM_TIMEOUT_SEC == 10.0
    assert _reload_with_timeout(monkeypatch, "nan").RUNTIME_RESOLVER_IAM_TIMEOUT_SEC == 10.0
    assert _reload_with_timeout(monkeypatch, "12.5").RUNTIME_RESOLVER_IAM_TIMEOUT_SEC == 12.5
    assert _reload_with_timeout(monkeypatch, "9999").RUNTIME_RESOLVER_IAM_TIMEOUT_SEC == 300.0


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
async def test_runtime_resolver_iam_get_uses_bounded_default_timeout(monkeypatch):
    module = _reload_with_timeout(monkeypatch, "12.5")

    async def fake_token():
        return "service.jwt"

    FakeAsyncClient.responses = [
        httpx.Response(
            200,
            json={"id": "mcp-1"},
            request=httpx.Request("GET", "http://iam.local/mcp-servers/mcp-1"),
        )
    ]
    FakeAsyncClient.calls = []
    FakeAsyncClient.timeouts = []
    monkeypatch.setattr(module, "get_iam_service_token", fake_token)
    monkeypatch.setattr(module.httpx, "AsyncClient", FakeAsyncClient)

    response = await module._iam_get("http://iam.local/mcp-servers/mcp-1")

    assert response == {"id": "mcp-1"}
    assert FakeAsyncClient.calls == [("GET", "http://iam.local/mcp-servers/mcp-1")]
    assert FakeAsyncClient.timeouts == [12.5]


def test_runtime_resolver_uses_bounded_timeout_constant():
    source = Path("services/context_api_service/app/execute_modules/runtime_resolver.py").read_text()
    assert "from ..env_config import bounded_float_env" in source
    assert "CONTEXT_FABRIC_RUNTIME_RESOLVER_IAM_TIMEOUT_SEC" in source
    assert (
        'RUNTIME_RESOLVER_IAM_TIMEOUT_SEC = bounded_float_env(\n'
        '    "CONTEXT_FABRIC_RUNTIME_RESOLVER_IAM_TIMEOUT_SEC",'
    ) in source
    assert "timeout=RUNTIME_RESOLVER_IAM_TIMEOUT_SEC" in source
    assert "timeout=10.0" not in source
    assert "timeout=30.0" not in source
