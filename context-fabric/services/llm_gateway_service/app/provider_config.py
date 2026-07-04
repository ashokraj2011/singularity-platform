"""M33 — Loads + caches the external provider config + model alias catalog.

Source of truth: `.singularity/llm-providers.json` + `.singularity/mcp-models.json`.
Mounted into this container; no other service mounts these files after M33.
"""
from __future__ import annotations

import json
import math
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
_MAX_PRICE_PER_MTOK = 10_000.0


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
    if not path.exists():
        # Back-compat: the catalog was historically named `mcp-models.json`; the
        # canonical name is now `llm-models.json` (it has nothing to do with MCP —
        # it is the LLM gateway's model-alias catalog). Fall back to the sibling
        # alternate name so old configs/mounts keep working.
        alt = path.with_name("llm-models.json" if path.name == "mcp-models.json" else "mcp-models.json")
        if alt.exists():
            path = alt
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
        _warnings.append("Model catalog must be a JSON array; alias resolution unavailable.")
        _loaded_catalog = []
        return _loaded_catalog
    _loaded_catalog = _sanitize_catalog(raw)
    return _loaded_catalog


def _sanitize_catalog(raw: List[Any]) -> List[Dict[str, Any]]:
    sanitized: List[Dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            _warnings.append(f"Model catalog entry {index} ignored: expected object.")
            continue
        model_id = str(entry.get("id") or "").strip()
        if not model_id:
            _warnings.append(f"Model catalog entry {index} ignored: missing id.")
            continue
        if model_id in seen_ids:
            _warnings.append(f"Model catalog entry {index} ignored: duplicate id {model_id}.")
            continue
        seen_ids.add(model_id)
        clean = dict(entry)
        clean["id"] = model_id
        if "provider" in clean:
            clean["provider"] = str(clean.get("provider") or "").lower()
        sanitized.append(clean)
    return sanitized


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


# M56 — Cost computation. The catalog optionally carries
# inputPricePerMtok / outputPricePerMtok per model (USD per 1M tokens).
# When both are present we return a real number; missing → None so the
# caller surfaces it as null (no fake $0.00 in the UI).
def compute_estimated_cost(
    alias: Optional[str],
    input_tokens: int,
    output_tokens: int,
) -> Optional[float]:
    if not alias:
        return None
    try:
        entry = resolve_alias(alias)
    except ProviderConfigError:
        return None
    in_price = entry.get("inputPricePerMtok")
    out_price = entry.get("outputPricePerMtok")
    input_rate = _safe_price_per_mtok(in_price)
    output_rate = _safe_price_per_mtok(out_price)
    if input_rate is None or output_rate is None:
        return None
    # Per-million-token rates. Round to 6 decimals (fraction of a cent
    # precision is plenty for accounting and avoids float noise in JSON).
    cost = (input_tokens * input_rate + output_tokens * output_rate) / 1_000_000.0
    return round(cost, 6)


def _safe_price_per_mtok(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    price = float(value)
    if not math.isfinite(price) or price < 0 or price > _MAX_PRICE_PER_MTOK:
        return None
    return price


# ── UI-managed catalog writes ───────────────────────────────────────────────
# The /llm-settings UI adds/edits/removes models. We mutate the SAME
# llm-models.json the gateway reads (the file IS the persistence), then drop the
# in-memory cache so the change is live without a gateway restart.
_MODEL_FIELDS = (
    "id", "label", "provider", "model", "default", "maxOutputTokens",
    "supportsTools", "costTier", "description", "inputPricePerMtok",
    "outputPricePerMtok",
)
_MODEL_REQUIRED = ("id", "provider", "model")


def _catalog_write_path() -> Path:
    # Mirror _load_catalog()'s back-compat name resolution so we write the file
    # the gateway actually reads.
    path = Path(settings.model_catalog_path)
    if not path.exists():
        alt = path.with_name("llm-models.json" if path.name == "mcp-models.json" else "mcp-models.json")
        if alt.exists():
            return alt
    return path


def _persist_catalog(models: List[Dict[str, Any]]) -> None:
    global _loaded_catalog
    path = _catalog_write_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(models, indent=2) + "\n")
    _loaded_catalog = None  # force re-read on next access → the change is live


def _clean_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    return {k: entry[k] for k in _MODEL_FIELDS if entry.get(k) is not None}


def add_model(entry: Dict[str, Any]) -> Dict[str, Any]:
    clean = _clean_entry(entry)
    for k in _MODEL_REQUIRED:
        if not str(clean.get(k) or "").strip():
            raise ProviderConfigError(f"missing required field: {k}")
    provider = str(clean["provider"]).lower()
    if provider not in SUPPORTED_PROVIDERS:
        raise ProviderConfigError(f"unsupported provider: {provider} (one of {', '.join(SUPPORTED_PROVIDERS)})")
    clean["provider"] = provider
    models = list(_load_catalog())
    if any(m.get("id") == clean["id"] for m in models):
        raise ProviderConfigError(f"model id already exists: {clean['id']}")
    if clean.get("default"):
        for m in models:
            m["default"] = False
    models.append(clean)
    _persist_catalog(models)
    return clean


def update_model(model_id: str, patch: Dict[str, Any]) -> Dict[str, Any]:
    models = list(_load_catalog())
    idx = next((i for i, m in enumerate(models) if m.get("id") == model_id), -1)
    if idx < 0:
        raise ProviderConfigError(f"unknown model id: {model_id}")
    clean = _clean_entry(patch)
    clean.pop("id", None)  # id is the immutable key
    if "provider" in clean:
        p = str(clean["provider"]).lower()
        if p not in SUPPORTED_PROVIDERS:
            raise ProviderConfigError(f"unsupported provider: {p}")
        clean["provider"] = p
    if clean.get("default"):
        for m in models:
            m["default"] = False
    models[idx] = {**models[idx], **clean}
    _persist_catalog(models)
    return models[idx]


def delete_model(model_id: str) -> None:
    models = list(_load_catalog())
    if not any(m.get("id") == model_id for m in models):
        raise ProviderConfigError(f"unknown model id: {model_id}")
    _persist_catalog([m for m in models if m.get("id") != model_id])


def warnings() -> List[str]:
    return list(_warnings)


def unique_warnings(values: List[str]) -> List[str]:
    out: List[str] = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in out:
            out.append(text)
    return out


def reset_cache_for_tests() -> None:
    """Test-only: drop cached config so the next load reads from disk."""
    global _loaded_providers, _loaded_catalog, _warnings
    _loaded_providers = None
    _loaded_catalog = None
    _warnings = []
