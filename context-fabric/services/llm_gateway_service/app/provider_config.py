"""M33 — Loads + caches the external provider config + model alias catalog.

Source of truth: `.singularity/llm-providers.json` + `.singularity/mcp-models.json`.
Mounted into this container; no other service mounts these files after M33.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import settings


SUPPORTED_PROVIDERS = ("mock", "openai", "openrouter", "anthropic", "copilot")


class ProviderConfigError(Exception):
    pass


class ProviderNotReadyError(ProviderConfigError):
    pass


_loaded_providers: Optional[Dict[str, Any]] = None
_loaded_catalog:   Optional[List[Dict[str, Any]]] = None
_warnings:         List[str] = []


def _load_providers() -> Dict[str, Any]:
    global _loaded_providers, _warnings
    if _loaded_providers is not None:
        return _loaded_providers
    path = Path(settings.provider_config_path)
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        _warnings.append(f"Provider config not found at {path}; defaulting to mock-only.")
        _loaded_providers = {
            "defaultProvider": "mock",
            "allowedProviders": ["mock"],
            "providers": {"mock": {"enabled": True}},
        }
        return _loaded_providers
    except Exception as exc:
        _warnings.append(f"Provider config parse error: {exc}; defaulting to mock-only.")
        _loaded_providers = {
            "defaultProvider": "mock",
            "allowedProviders": ["mock"],
            "providers": {"mock": {"enabled": True}},
        }
        return _loaded_providers
    if not isinstance(raw, dict):
        raise ProviderConfigError("Provider config must be a JSON object")
    _loaded_providers = raw
    return raw


def _load_catalog() -> List[Dict[str, Any]]:
    global _loaded_catalog
    if _loaded_catalog is not None:
        return _loaded_catalog
    path = Path(settings.model_catalog_path)
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        _warnings.append(f"Model catalog not found at {path}; alias resolution unavailable.")
        _loaded_catalog = []
        return _loaded_catalog
    except Exception as exc:
        _warnings.append(f"Model catalog parse error: {exc}; alias resolution unavailable.")
        _loaded_catalog = []
        return _loaded_catalog
    if not isinstance(raw, list):
        raise ProviderConfigError("Model catalog must be a JSON array")
    _loaded_catalog = raw
    return raw


def default_provider() -> str:
    provider = str(_load_providers().get("defaultProvider", "mock")).lower()
    return provider if provider in SUPPORTED_PROVIDERS else "mock"


def default_model_alias() -> Optional[str]:
    for entry in _load_catalog():
        if entry.get("default"):
            return entry.get("id")
    if _load_catalog():
        return _load_catalog()[0].get("id")
    return None


def provider_settings(provider: str) -> Dict[str, Any]:
    return _load_providers().get("providers", {}).get(provider.lower(), {})


def provider_base_url(provider: str) -> str:
    """Return the configured provider base URL.

    Non-mock providers must declare `baseUrl` in the external provider config.
    There are intentionally no hard-coded OpenAI/Anthropic/OpenRouter/Copilot
    URL fallbacks here.
    """
    p = provider.lower()
    if p == "mock":
        return ""
    s = provider_settings(p)
    base_url = str(s.get("baseUrl") or "").strip()
    if not base_url:
        raise ProviderConfigError(f"provider {p} is missing baseUrl in provider config")
    return base_url


def provider_default_model(provider: str) -> str:
    s = provider_settings(provider)
    return s.get("defaultModel", "")


def is_provider_allowed(provider: str) -> bool:
    p = provider.lower()
    if p not in SUPPORTED_PROVIDERS:
        return False
    settings_block = _load_providers()
    providers = settings_block.get("providers", {})
    pr = providers.get(p, {})
    if p != "mock" and not pr:
        return False
    if pr.get("enabled") is False:
        return False
    allowed = settings_block.get("allowedProviders")
    if allowed:
        return p in allowed
    return True


def provider_unready_reasons(provider: str, credential: Optional[str]) -> List[str]:
    p = provider.lower()
    reasons: List[str] = []
    if not is_provider_allowed(p):
        reasons.append("Provider blocked, disabled, unsupported, or missing from external config")
        return reasons
    if p == "mock":
        return reasons
    settings_block = provider_settings(p)
    if not str(settings_block.get("baseUrl") or "").strip():
        reasons.append("Missing baseUrl in external provider config")
    if not str(settings_block.get("credentialEnv") or "").strip():
        reasons.append("Missing credentialEnv in external provider config")
    if not credential:
        reasons.append("Missing credential")
    return reasons


def provider_ready(provider: str, credential: Optional[str]) -> bool:
    """Ready means explicitly configured, allowed, baseUrl-present, and
    credential-present. Mock has no credential/baseUrl requirement.
    """
    return len(provider_unready_reasons(provider, credential)) == 0


def validate_model_entry(entry: Dict[str, Any], credentials: Dict[str, Optional[str]]) -> None:
    provider = str(entry.get("provider") or "").lower()
    model = str(entry.get("model") or "").strip()
    if provider not in SUPPORTED_PROVIDERS:
        raise ProviderConfigError(f"unsupported provider for alias {entry.get('id')}: {provider}")
    if not model:
        raise ProviderConfigError(f"model alias {entry.get('id')} is missing model")
    reasons = provider_unready_reasons(provider, credentials.get(provider))
    if reasons:
        raise ProviderNotReadyError(f"model alias {entry.get('id')} is not ready: {'; '.join(reasons)}")


def list_provider_status(credentials: Dict[str, Optional[str]]) -> List[Dict[str, Any]]:
    out = []
    for p in SUPPORTED_PROVIDERS:
        cred = credentials.get(p)
        ready = provider_ready(p, cred)
        reasons = provider_unready_reasons(p, cred)
        out.append({
            "name": p,
            "ready": ready,
            "allowed": is_provider_allowed(p),
            "default_model": provider_default_model(p) or None,
            "warnings": [] if ready else reasons,
        })
    return out


def resolve_alias(alias: str) -> Dict[str, Any]:
    for entry in _load_catalog():
        if entry.get("id") == alias:
            return entry
    raise ProviderConfigError(f"unknown model alias: {alias}")


def warnings() -> List[str]:
    return list(_warnings)


def reset_cache_for_tests() -> None:
    """Test-only: drop cached config so the next load reads from disk."""
    global _loaded_providers, _loaded_catalog, _warnings
    _loaded_providers = None
    _loaded_catalog = None
    _warnings = []
