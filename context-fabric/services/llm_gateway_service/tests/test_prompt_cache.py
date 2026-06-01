"""ADR 0003 — server-level prompt caching wire-format tests.

Verifies the Anthropic provider injects cache_control breakpoints + the
prompt-caching beta header ONLY when the caller opts in, and that the
gateway echoes cache usage back. Captures the exact JSON body posted to
Anthropic via a fake httpx client (same harness as test_gateway_hardening).
"""
from __future__ import annotations

import asyncio
import importlib
import json
import sys
from pathlib import Path

import pytest


MODULES = [
    "services.llm_gateway_service.app.config",
    "services.llm_gateway_service.app.provider_config",
    "services.llm_gateway_service.app.router",
]


def _load_router(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    providers = {
        "defaultProvider": "anthropic",
        "allowedProviders": ["anthropic"],
        "providers": {
            "anthropic": {
                "enabled": True,
                "baseUrl": "https://api.anthropic.com",
                "credentialEnv": "ANTHROPIC_API_KEY",
                "defaultModel": "claude-haiku-4-5-20251001",
            }
        },
    }
    catalog = [{"id": "anthropic", "provider": "anthropic", "model": "claude-haiku-4-5-20251001", "default": True}]
    (tmp_path / "llm-providers.json").write_text(json.dumps(providers))
    (tmp_path / "mcp-models.json").write_text(json.dumps(catalog))
    monkeypatch.setenv("LLM_PROVIDER_CONFIG_PATH", str(tmp_path / "llm-providers.json"))
    monkeypatch.setenv("LLM_MODEL_CATALOG_PATH", str(tmp_path / "mcp-models.json"))
    monkeypatch.delenv("LLM_PROMPT_CACHE_ENABLED", raising=False)
    for name in MODULES:
        sys.modules.pop(name, None)
    importlib.import_module("services.llm_gateway_service.app.config")
    importlib.import_module("services.llm_gateway_service.app.provider_config")
    return importlib.import_module("services.llm_gateway_service.app.router")


def _install_capturing_client(monkeypatch, anthropic, *, usage: dict | None = None):
    """Patch anthropic.httpx.AsyncClient to capture the posted body+headers
    and return a canned 200. Returns a dict that fills with 'body'/'headers'."""
    captured: dict = {}

    class FakeResponse:
        status_code = 200
        text = ""

        def json(self) -> dict:
            return {
                "content": [{"type": "text", "text": "ok"}],
                "stop_reason": "end_turn",
                "usage": usage or {"input_tokens": 5, "output_tokens": 2},
            }

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_a):
            return None

        async def post(self, _url, headers=None, json=None):  # noqa: A002
            captured["headers"] = headers or {}
            captured["body"] = json or {}
            return FakeResponse()

    monkeypatch.setattr(anthropic, "provider_base_url", lambda _p: "https://api.anthropic.com")
    monkeypatch.setattr(anthropic.httpx, "AsyncClient", FakeClient)
    return captured


def _run(anthropic, req, router):
    return asyncio.run(anthropic.respond(
        req,
        resolved_model="claude-haiku-4-5-20251001",
        api_key="test-key",
        model_alias="anthropic",
    ))


def test_cache_control_injected_when_enabled(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    router = _load_router(monkeypatch, tmp_path)
    anthropic = router.anthropic_provider
    captured = _install_capturing_client(
        monkeypatch, anthropic,
        usage={"input_tokens": 5, "output_tokens": 2,
               "cache_creation_input_tokens": 100, "cache_read_input_tokens": 0},
    )

    req = router.ChatCompletionRequest(
        model_alias="anthropic",
        messages=[{"role": "system", "content": "stable system prefix"},
                  {"role": "user", "content": "hello"}],
        tools=[{"name": "read_file", "description": "d", "input_schema": {"type": "object"}}],
        prompt_cache={"enabled": True, "strategy": "provider_auto"},
    )
    resp = _run(anthropic, req, router)

    body = captured["body"]
    # System converted to block form with a cache breakpoint.
    assert isinstance(body["system"], list)
    assert body["system"][-1]["cache_control"] == {"type": "ephemeral"}
    # Last tool carries a cache breakpoint.
    assert body["tools"][-1]["cache_control"] == {"type": "ephemeral"}
    # Beta header sent.
    assert captured["headers"].get("anthropic-beta") == anthropic.settings.anthropic_prompt_cache_beta
    # Usage echoed back.
    assert resp.prompt_cache is not None
    assert resp.prompt_cache["enabled"] is True
    assert resp.prompt_cache["cache_creation_input_tokens"] == 100
    assert resp.prompt_cache["reported"] is True


def test_no_cache_control_when_not_requested(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    router = _load_router(monkeypatch, tmp_path)
    anthropic = router.anthropic_provider
    captured = _install_capturing_client(monkeypatch, anthropic)

    req = router.ChatCompletionRequest(
        model_alias="anthropic",
        messages=[{"role": "system", "content": "stable system prefix"},
                  {"role": "user", "content": "hello"}],
        tools=[{"name": "read_file", "description": "d", "input_schema": {"type": "object"}}],
        # no prompt_cache
    )
    resp = _run(anthropic, req, router)

    body = captured["body"]
    # System stays a plain string; no breakpoints; no beta header.
    assert isinstance(body["system"], str)
    assert "cache_control" not in body["tools"][-1]
    assert "anthropic-beta" not in captured["headers"]
    # No cache activity reported and none requested → prompt_cache is None.
    assert resp.prompt_cache is None


def test_kill_switch_disables_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    router = _load_router(monkeypatch, tmp_path)
    anthropic = router.anthropic_provider
    # The provider binds `settings` at import; mutate the live object directly
    # (same convention as test_gateway_hardening's retry test) rather than via
    # env, which a module reload wouldn't rebind here.
    monkeypatch.setattr(anthropic.settings, "prompt_cache_enabled", False)
    captured = _install_capturing_client(monkeypatch, anthropic)

    req = router.ChatCompletionRequest(
        model_alias="anthropic",
        messages=[{"role": "system", "content": "stable system prefix"},
                  {"role": "user", "content": "hello"}],
        tools=[{"name": "read_file", "description": "d", "input_schema": {"type": "object"}}],
        prompt_cache={"enabled": True, "strategy": "provider_auto"},
    )
    _run(anthropic, req, router)

    body = captured["body"]
    # Kill switch on the gateway wins even though the caller asked for caching.
    assert isinstance(body["system"], str)
    assert "cache_control" not in body["tools"][-1]
    assert "anthropic-beta" not in captured["headers"]
