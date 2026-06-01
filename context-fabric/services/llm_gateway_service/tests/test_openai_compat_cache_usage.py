"""ADR 0003 — OpenAI-compatible (OpenAI / Azure / GitHub Copilot) prompt-cache
usage read-back.

Caching on these backends is AUTOMATIC (no request flag), so the gateway's job
is only to READ usage.prompt_tokens_details.cached_tokens back and surface it as
response.prompt_cache — mirroring the Anthropic provider's shape. These tests
drive openai_compat.respond() with a fake httpx client returning canned usage
shapes and assert the read-back is correct and defensive.
"""
from __future__ import annotations

import asyncio

import pytest

from services.llm_gateway_service.app.providers import openai_compat


def _install_fake_client(monkeypatch, *, usage: dict):
    """Patch openai_compat.httpx.AsyncClient with a fake that returns a 200
    chat-completion carrying the given usage block."""
    class FakeResp:
        status_code = 200
        text = ""

        def json(self):
            return {
                "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
                "usage": usage,
            }

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, _url, headers=None, json=None):  # noqa: A002
            return FakeResp()

    monkeypatch.setattr(openai_compat, "provider_base_url", lambda _p: "https://api.githubcopilot.com")
    monkeypatch.setattr(openai_compat.httpx, "AsyncClient", FakeClient)


def _run(usage: dict, monkeypatch):
    _install_fake_client(monkeypatch, usage=usage)
    req = openai_compat.ChatCompletionRequest(
        model_alias="copilot",
        messages=[{"role": "user", "content": "hello"}],
    )
    return asyncio.run(openai_compat.respond(
        req, provider="copilot", resolved_model="gpt-4.1", api_key="test-key", model_alias="copilot",
    ))


def test_cache_hit_reported(monkeypatch: pytest.MonkeyPatch):
    resp = _run(
        {"prompt_tokens": 2000, "completion_tokens": 50,
         "prompt_tokens_details": {"cached_tokens": 1536}},
        monkeypatch,
    )
    assert resp.input_tokens == 2000
    assert resp.prompt_cache is not None
    assert resp.prompt_cache["cache_read_input_tokens"] == 1536
    # OpenAI/Azure/Copilot report no separate cache-write count.
    assert resp.prompt_cache["cache_creation_input_tokens"] == 0
    assert resp.prompt_cache["reported"] is True
    assert resp.prompt_cache["enabled"] is True


def test_cache_field_present_but_zero(monkeypatch: pytest.MonkeyPatch):
    # Below the 1024-token threshold the provider reports cached_tokens: 0.
    # The field WAS present, so we still surface a (zero-hit) prompt_cache.
    resp = _run(
        {"prompt_tokens": 300, "completion_tokens": 10,
         "prompt_tokens_details": {"cached_tokens": 0}},
        monkeypatch,
    )
    assert resp.prompt_cache is not None
    assert resp.prompt_cache["cache_read_input_tokens"] == 0
    assert resp.prompt_cache["reported"] is True


def test_no_details_means_no_prompt_cache(monkeypatch: pytest.MonkeyPatch):
    # Many OpenAI-compatible responses (and some Copilot models) omit
    # prompt_tokens_details entirely. We must NOT fabricate a 0-hit block —
    # prompt_cache stays None so callers can tell "not reported" from "0 hits".
    resp = _run({"prompt_tokens": 2000, "completion_tokens": 50}, monkeypatch)
    assert resp.input_tokens == 2000
    assert resp.prompt_cache is None


def test_details_present_but_cached_tokens_null(monkeypatch: pytest.MonkeyPatch):
    # Defensive: details dict present but cached_tokens explicitly null.
    resp = _run(
        {"prompt_tokens": 2000, "completion_tokens": 50,
         "prompt_tokens_details": {"cached_tokens": None}},
        monkeypatch,
    )
    assert resp.prompt_cache is None
