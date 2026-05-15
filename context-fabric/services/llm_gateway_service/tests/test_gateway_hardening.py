from __future__ import annotations

import importlib
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

    assert exc.value.status_code == 400
    assert "Missing baseUrl" in str(exc.value.detail)


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
