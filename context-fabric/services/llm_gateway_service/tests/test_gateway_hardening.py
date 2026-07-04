from __future__ import annotations

import importlib
import asyncio
import json
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException


MODULES = [
    "services.llm_gateway_service.app.config",
    "services.llm_gateway_service.app.provider_config",
    "services.llm_gateway_service.app.router",
]


def load_modules(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, providers: dict | None, catalog: list | None):
    provider_path = tmp_path / "llm-providers.json"
    catalog_path = tmp_path / "mcp-models.json"
    if providers is not None:
        provider_path.write_text(json.dumps(providers))
    if catalog is not None:
        catalog_path.write_text(json.dumps(catalog))
    monkeypatch.setenv("LLM_PROVIDER_CONFIG_PATH", str(provider_path))
    monkeypatch.setenv("LLM_MODEL_CATALOG_PATH", str(catalog_path))
    monkeypatch.setenv("ALLOW_CALLER_PROVIDER_OVERRIDE", "false")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("COPILOT_TOKEN", raising=False)
    for name in MODULES:
        sys.modules.pop(name, None)
    config = importlib.import_module("services.llm_gateway_service.app.config")
    provider_config = importlib.import_module("services.llm_gateway_service.app.provider_config")
    router = importlib.import_module("services.llm_gateway_service.app.router")
    return config, provider_config, router


def test_missing_provider_config_defaults_to_mock_only(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    _, provider_config, router = load_modules(monkeypatch, tmp_path, None, None)

    assert provider_config.default_provider() == "mock"
    assert provider_config.is_provider_allowed("mock")
    assert not provider_config.is_provider_allowed("openai")
    assert router._resolve_provider_and_model(model_alias=None, provider=None, model=None) == (  # noqa: SLF001
        "mock",
        "mock-fast",
        None,
    )


def test_openai_alias_without_base_url_is_rejected(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    providers = {
        "defaultProvider": "openai",
        "allowedProviders": ["openai"],
        "providers": {
            "openai": {
                "enabled": True,
                "credentialEnv": "OPENAI_API_KEY",
                "defaultModel": "gpt-test",
            }
        },
    }
    catalog = [{"id": "openai-test", "provider": "openai", "model": "gpt-test", "default": True}]
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    _, _, router = load_modules(monkeypatch, tmp_path, providers, catalog)

    with pytest.raises(HTTPException) as exc:
        router._resolve_provider_and_model(model_alias="openai-test", provider=None, model=None)  # noqa: SLF001

    assert exc.value.status_code == 503
    assert "Missing baseUrl" in str(exc.value.detail)


def test_openai_alias_without_credential_is_provider_not_ready(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    providers = {
        "defaultProvider": "openai",
        "allowedProviders": ["openai"],
        "providers": {
            "openai": {
                "enabled": True,
                "baseUrl": "https://gateway.example.test/v1",
                "credentialEnv": "OPENAI_API_KEY",
                "defaultModel": "gpt-test",
            }
        },
    }
    catalog = [{"id": "openai-test", "provider": "openai", "model": "gpt-test", "default": True}]
    _, _, router = load_modules(monkeypatch, tmp_path, providers, catalog)

    with pytest.raises(HTTPException) as exc:
        router._resolve_provider_and_model(model_alias="openai-test", provider=None, model=None)  # noqa: SLF001

    assert exc.value.status_code == 503
    assert "Missing credential" in str(exc.value.detail)


def test_raw_provider_model_rejected_when_override_disabled(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    providers = {
        "defaultProvider": "mock",
        "allowedProviders": ["mock"],
        "providers": {"mock": {"enabled": True, "defaultModel": "mock-fast"}},
    }
    _, _, router = load_modules(monkeypatch, tmp_path, providers, [])

    with pytest.raises(HTTPException) as exc:
        router._resolve_provider_and_model(model_alias=None, provider="mock", model="mock-fast")  # noqa: SLF001

    assert exc.value.status_code == 400
    assert "provider/model override disabled" in str(exc.value.detail)


def test_mock_alias_succeeds(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    providers = {
        "defaultProvider": "mock",
        "allowedProviders": ["mock"],
        "providers": {"mock": {"enabled": True, "defaultModel": "mock-fast"}},
    }
    catalog = [{"id": "mock", "provider": "mock", "model": "mock-fast", "default": True}]
    _, _, router = load_modules(monkeypatch, tmp_path, providers, catalog)

    assert router._resolve_provider_and_model(model_alias="mock", provider=None, model=None) == (  # noqa: SLF001
        "mock",
        "mock-fast",
        "mock",
    )


def test_expected_model_guard_rejects_alias_drift_before_provider_call(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    providers = {
        "defaultProvider": "mock",
        "allowedProviders": ["mock"],
        "providers": {"mock": {"enabled": True, "defaultModel": "mock-fast"}},
    }
    catalog = [{"id": "mock", "provider": "mock", "model": "mock-fast", "default": True}]
    _, _, router = load_modules(monkeypatch, tmp_path, providers, catalog)

    async def should_not_dispatch(*_args, **_kwargs):
        raise AssertionError("provider dispatch must not run when expected_model mismatches")

    monkeypatch.setattr(router.mock_provider, "respond", should_not_dispatch)
    req = router.ChatCompletionRequest(
        model_alias="mock",
        expected_provider="mock",
        expected_model="mock-slow",
        messages=[{"role": "user", "content": "hello"}],
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(router.chat_completions(req))

    assert exc.value.status_code == 409
    assert "does not match expected model mock-slow" in str(exc.value.detail)


def test_non_mock_embeddings_response_uses_resolved_model(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    providers = {
        "defaultProvider": "openai",
        "allowedProviders": ["openai"],
        "providers": {
            "openai": {
                "enabled": True,
                "baseUrl": "https://gateway.example.test/v1",
                "credentialEnv": "OPENAI_API_KEY",
                "defaultModel": "text-embedding-test",
            }
        },
    }
    catalog = [{"id": "embed-test", "provider": "openai", "model": "text-embedding-test", "default": True}]
    _, _, router = load_modules(monkeypatch, tmp_path, providers, catalog)
    router.settings.openai_api_key = "test-key"

    async def fake_embed(input_texts, *, provider, resolved_model, api_key):
        assert provider == "openai"
        assert resolved_model == "text-embedding-test"
        assert api_key == "test-key"
        return [[0.1, 0.2, 0.3] for _ in input_texts], 7

    monkeypatch.setattr(router.openai_provider, "embed", fake_embed)
    req = router.EmbeddingsRequest(model_alias="embed-test", input=["hello"])

    resp = asyncio.run(router.embeddings(req, authorization=None))

    assert resp.model == "text-embedding-test"
    assert resp.provider == "openai"
    assert resp.model_alias == "embed-test"
    assert resp.input_tokens == 7


def test_anthropic_retries_once_on_rate_limit(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
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
    _, _, router = load_modules(monkeypatch, tmp_path, providers, catalog)
    anthropic = router.anthropic_provider
    anthropic.settings.upstream_rate_limit_retries = 1
    anthropic.settings.upstream_rate_limit_retry_delay_sec = 0.0
    anthropic.settings.upstream_rate_limit_max_sleep_sec = 0.0
    monkeypatch.setattr(anthropic, "provider_base_url", lambda _provider: "https://api.anthropic.com")
    calls = {"count": 0}
    sleeps: list[float] = []

    class FakeResponse:
        def __init__(self, status_code: int, text: str = "", data: dict | None = None, headers: dict | None = None):
            self.status_code = status_code
            self.text = text or (json.dumps(data) if data is not None else "")
            self._data = data or {}
            self.headers = headers or {}

        def json(self) -> dict:
            raise AssertionError("provider adapters must parse upstream response text, not call response.json()")

    class FakeClient:
        def __init__(self, timeout: int):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            calls["count"] += 1
            if calls["count"] == 1:
                return FakeResponse(429, "rate limited", headers={"retry-after": "0"})
            return FakeResponse(
                200,
                data={
                    "content": [{"type": "text", "text": "ok"}],
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 3, "output_tokens": 1},
                },
            )

    async def fake_sleep(delay: float):
        sleeps.append(delay)

    monkeypatch.setattr(anthropic.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(anthropic.asyncio, "sleep", fake_sleep)

    req = router.ChatCompletionRequest(
        model_alias="anthropic",
        messages=[{"role": "user", "content": "hello"}],
        max_output_tokens=10,
    )
    resp = asyncio.run(anthropic.respond(
        req,
        resolved_model="claude-haiku-4-5-20251001",
        api_key="test-key",
        model_alias="anthropic",
    ))

    assert calls["count"] == 2
    assert sleeps == [0.0]
    assert resp.content == "ok"
    assert resp.input_tokens == 3


def test_openai_chat_invalid_json_surfaces_as_upstream_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    providers = {
        "defaultProvider": "openai",
        "allowedProviders": ["openai"],
        "providers": {
            "openai": {
                "enabled": True,
                "baseUrl": "https://gateway.example.test/v1",
                "credentialEnv": "OPENAI_API_KEY",
                "defaultModel": "gpt-test",
            }
        },
    }
    catalog = [{"id": "openai-test", "provider": "openai", "model": "gpt-test", "default": True}]
    _, _, router = load_modules(monkeypatch, tmp_path, providers, catalog)
    router.settings.openai_api_key = "test-key"
    openai = router.openai_provider
    monkeypatch.setattr(openai, "provider_base_url", lambda _provider: "https://gateway.example.test/v1")

    class FakeResponse:
        status_code = 200
        text = "Internal Server Error"

        def json(self) -> dict:
            raise ValueError("not json")

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(openai.httpx, "AsyncClient", FakeClient)

    req = router.ChatCompletionRequest(model_alias="openai-test", messages=[{"role": "user", "content": "hello"}])

    with pytest.raises(HTTPException) as exc:
        asyncio.run(router.chat_completions(req))

    assert exc.value.status_code == 502
    assert "invalid JSON" in str(exc.value.detail)


def test_openai_embeddings_invalid_json_surfaces_as_upstream_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    providers = {
        "defaultProvider": "openai",
        "allowedProviders": ["openai"],
        "providers": {
            "openai": {
                "enabled": True,
                "baseUrl": "https://gateway.example.test/v1",
                "credentialEnv": "OPENAI_API_KEY",
                "defaultModel": "text-embedding-test",
            }
        },
    }
    catalog = [{"id": "embed-test", "provider": "openai", "model": "text-embedding-test", "default": True}]
    _, _, router = load_modules(monkeypatch, tmp_path, providers, catalog)
    router.settings.openai_api_key = "test-key"
    openai = router.openai_provider
    monkeypatch.setattr(openai, "provider_base_url", lambda _provider: "https://gateway.example.test/v1")

    class FakeResponse:
        status_code = 200
        text = "<html>bad gateway</html>"

        def json(self) -> dict:
            raise ValueError("not json")

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(openai.httpx, "AsyncClient", FakeClient)

    req = router.EmbeddingsRequest(model_alias="embed-test", input=["hello"])

    with pytest.raises(HTTPException) as exc:
        asyncio.run(router.embeddings(req))

    assert exc.value.status_code == 502
    assert "invalid JSON" in str(exc.value.detail)


def test_anthropic_invalid_json_surfaces_as_upstream_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
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
    _, _, router = load_modules(monkeypatch, tmp_path, providers, catalog)
    router.settings.anthropic_api_key = "test-key"
    anthropic = router.anthropic_provider
    monkeypatch.setattr(anthropic, "provider_base_url", lambda _provider: "https://api.anthropic.com")

    class FakeResponse:
        status_code = 200
        text = "proxy says nope"
        headers: dict = {}

        def json(self) -> dict:
            raise ValueError("not json")

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(anthropic.httpx, "AsyncClient", FakeClient)

    req = router.ChatCompletionRequest(
        model_alias="anthropic",
        messages=[{"role": "user", "content": "hello"}],
        max_output_tokens=10,
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(router.chat_completions(req))

    assert exc.value.status_code == 502
    assert "invalid JSON" in str(exc.value.detail)
