"""Consumer-side gateway discovery tests (M11.a).

Covers _resolve_gateway_url in context_api_service's llm_client:
  - registry unset → static LLM_GATEWAY_URL (no behavior change);
  - registry hit → internal_url preferred, else base_url;
  - 404 / timeout / error → fall back to static URL;
  - result is cached within the TTL and re-resolved after it expires;
  - the LLM_GATEWAY_URL=="mock" short-circuit is untouched (callers never
    reach the resolver in mock mode).

The resolver reads its config from module-level globals captured at import,
so we monkeypatch those directly and reset the module cache each test.
"""
from __future__ import annotations

import asyncio

import pytest

from context_api_service.app.governed import llm_client as lc


@pytest.fixture(autouse=True)
def _reset_cache(monkeypatch: pytest.MonkeyPatch):
    # Module-global cache is test-isolation-hostile — reset before each case.
    monkeypatch.setattr(lc, "_GATEWAY_CACHE", {"url": None, "expires_at": 0.0})
    monkeypatch.setattr(lc, "_GATEWAY_URL", "http://static-gateway:8001")
    monkeypatch.setattr(lc, "_GATEWAY_SERVICE_NAME", "llm-gateway")
    monkeypatch.setattr(lc, "_DISCOVERY_TTL_SEC", 30.0)
    monkeypatch.setattr(lc, "_DISCOVERY_TIMEOUT_SEC", 2.0)
    yield


def _fake_client(*, status: int, body: dict | None = None, raises: Exception | None = None):
    """Build a FakeClient class whose .get returns a canned response or raises.
    Records the URLs it was asked for in `calls`."""
    calls: list[str] = []
    timeouts: list[float] = []

    class FakeResp:
        status_code = status

        def json(self):
            return body or {}

    class FakeClient:
        def __init__(self, *a, **k):
            timeouts.append(k.get("timeout"))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def get(self, url, *a, **k):
            calls.append(url)
            if raises is not None:
                raise raises
            return FakeResp()

    return FakeClient, calls, timeouts


def test_registry_unset_returns_static_url(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(lc, "_REGISTRY_URL", "")
    # Even if httpx were called it would fail the test; assert no call happens.
    FakeClient, calls, timeouts = _fake_client(status=200, body={"base_url": "http://should-not-be-used"})
    monkeypatch.setattr(lc.httpx, "AsyncClient", FakeClient)
    url = asyncio.run(lc._resolve_gateway_url())
    assert url == "http://static-gateway:8001"
    assert calls == []  # discovery disabled → no registry call
    assert timeouts == []


def test_registry_hit_prefers_internal_url(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(lc, "_REGISTRY_URL", "http://registry:8090")
    FakeClient, calls, timeouts = _fake_client(
        status=200,
        body={"internal_url": "http://llm-gateway:8001/", "base_url": "http://host:8001"},
    )
    monkeypatch.setattr(lc.httpx, "AsyncClient", FakeClient)
    url = asyncio.run(lc._resolve_gateway_url())
    assert url == "http://llm-gateway:8001"  # internal_url wins, trailing / stripped
    assert calls == ["http://registry:8090/api/v1/services/llm-gateway"]
    assert timeouts == [2.0]


def test_registry_hit_falls_back_to_base_url_when_internal_null(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(lc, "_REGISTRY_URL", "http://registry:8090")
    FakeClient, _, _ = _fake_client(
        status=200, body={"internal_url": None, "base_url": "http://host:8001"},
    )
    monkeypatch.setattr(lc.httpx, "AsyncClient", FakeClient)
    assert asyncio.run(lc._resolve_gateway_url()) == "http://host:8001"


def test_404_falls_back_to_static(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(lc, "_REGISTRY_URL", "http://registry:8090")
    FakeClient, _, _ = _fake_client(status=404, body={"code": "NOT_FOUND"})
    monkeypatch.setattr(lc.httpx, "AsyncClient", FakeClient)
    assert asyncio.run(lc._resolve_gateway_url()) == "http://static-gateway:8001"


def test_timeout_falls_back_to_static(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(lc, "_REGISTRY_URL", "http://registry:8090")
    FakeClient, _, _ = _fake_client(status=200, raises=lc.httpx.TimeoutException("slow"))
    monkeypatch.setattr(lc.httpx, "AsyncClient", FakeClient)
    assert asyncio.run(lc._resolve_gateway_url()) == "http://static-gateway:8001"


def test_registry_lookup_uses_configured_discovery_timeout(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(lc, "_REGISTRY_URL", "http://registry:8090")
    monkeypatch.setattr(lc, "_DISCOVERY_TIMEOUT_SEC", 12.5)
    FakeClient, calls, timeouts = _fake_client(status=200, body={"base_url": "http://resolved:8001"})
    monkeypatch.setattr(lc.httpx, "AsyncClient", FakeClient)

    assert asyncio.run(lc._resolve_gateway_url()) == "http://resolved:8001"
    assert calls == ["http://registry:8090/api/v1/services/llm-gateway"]
    assert timeouts == [12.5]


def test_result_is_cached_within_ttl(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(lc, "_REGISTRY_URL", "http://registry:8090")
    FakeClient, calls, _ = _fake_client(status=200, body={"base_url": "http://resolved:8001"})
    monkeypatch.setattr(lc.httpx, "AsyncClient", FakeClient)

    async def _twice():
        a = await lc._resolve_gateway_url()
        b = await lc._resolve_gateway_url()
        return a, b

    a, b = asyncio.run(_twice())
    assert a == b == "http://resolved:8001"
    assert len(calls) == 1  # second call served from cache, not a 2nd registry GET


def test_cache_expires_and_reresolves(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(lc, "_REGISTRY_URL", "http://registry:8090")
    monkeypatch.setattr(lc, "_DISCOVERY_TTL_SEC", 0.0)  # expire immediately
    FakeClient, calls, _ = _fake_client(status=200, body={"base_url": "http://resolved:8001"})
    monkeypatch.setattr(lc.httpx, "AsyncClient", FakeClient)

    async def _twice():
        await lc._resolve_gateway_url()
        await lc._resolve_gateway_url()

    asyncio.run(_twice())
    assert len(calls) == 2  # TTL=0 → never a cache hit, re-resolves each time
