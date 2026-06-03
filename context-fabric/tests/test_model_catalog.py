"""Unit tests for the llm-gateway model-catalog client (code-context D1).

Exercises context_window_for via its test seams (_fetcher / _now) so no real
gateway/HTTP is touched.
"""
import pytest

from context_api_service.app.governed.model_catalog import context_window_for, _cache


@pytest.fixture(autouse=True)
def _reset_cache():
    _cache["by_key"] = {}
    _cache["expires_at"] = 0.0
    yield
    _cache["by_key"] = {}
    _cache["expires_at"] = 0.0


@pytest.mark.asyncio
async def test_maps_alias_to_window():
    async def fetcher():
        return {"claude-sonnet-4-5": 200_000, "gpt-4o": 128_000}

    clock = lambda: 1000.0  # noqa: E731
    assert await context_window_for("claude-sonnet-4-5", _fetcher=fetcher, _now=clock) == 200_000
    assert await context_window_for("gpt-4o", _fetcher=fetcher, _now=clock) == 128_000
    assert await context_window_for("unknown-model", _fetcher=fetcher, _now=clock) is None


@pytest.mark.asyncio
async def test_empty_alias_returns_none_without_fetch():
    async def boom():
        raise AssertionError("must not fetch for an empty alias")

    assert await context_window_for(None, _fetcher=boom) is None
    assert await context_window_for("", _fetcher=boom) is None


@pytest.mark.asyncio
async def test_caches_within_ttl():
    calls = {"n": 0}

    async def fetcher():
        calls["n"] += 1
        return {"m": 100}

    clock = lambda: 0.0  # noqa: E731 — fixed time keeps us inside the TTL
    assert await context_window_for("m", _fetcher=fetcher, _now=clock) == 100
    assert await context_window_for("m", _fetcher=fetcher, _now=clock) == 100
    assert calls["n"] == 1  # fetched once, served from cache thereafter


@pytest.mark.asyncio
async def test_cold_failure_returns_none():
    async def boom():
        raise RuntimeError("gateway down")

    assert await context_window_for("m", _fetcher=boom) is None
