"""M33 — Loads + caches the external provider config + model alias catalog.

Source of truth: `.singularity/llm-providers.json` + `.singularity/mcp-models.json`.
Mounted into this container; no other service mounts these files after M33.
"""
from __future__ import annotations

import json
import logging
import math
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
from typing import Any, Dict, List, Optional

from .config import settings


logger = logging.getLogger("llm_gateway.provider_config")

_TRUTHY = {"1", "true", "yes", "on"}


# Copilot is intentionally absent from the gateway provider catalog. Copilot
# coding stages use the governed `copilot_execute` MCP tool so the CLI runs on
# the selected runtime and produces the same audited code-change receipt.
SUPPORTED_PROVIDERS = ("mock", "openai", "openrouter", "anthropic")


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


def strict_default_alias() -> bool:
    """Whether an unmarked catalog may still supply an implicit default.

    Read per-call so an operator can flip it without a gateway restart, matching
    task_tags.require_task_tag().
    """
    return os.getenv("GATEWAY_STRICT_DEFAULT_ALIAS", "").strip().lower() in _TRUTHY


def default_model_alias() -> Optional[str]:
    """The platform's default model alias.

    When no catalog entry is marked `"default": true` this falls back to the
    FIRST entry — and used to do so in complete silence. That made catalog
    ORDER a load-bearing production setting nobody knew was one: a reorder in
    the /llm-settings UI, or a `DELETE /llm/models` removing the entry that
    happened to be first, silently repointed every untargeted call on the
    platform at a different model. No log line, no warning, no diff.

    The fallback is preserved (removing it outright would break every deployment
    with an unmarked catalog), but it is now visible in `warnings()` and in the
    gateway log, and refusable via GATEWAY_STRICT_DEFAULT_ALIAS.
    """
    catalog = _load_catalog()
    for entry in catalog:
        if entry.get("default"):
            return entry.get("id")
    if not catalog:
        return None
    implicit = catalog[0].get("id")
    if strict_default_alias():
        _warn_once(
            f"No model catalog entry is marked default and GATEWAY_STRICT_DEFAULT_ALIAS is set; "
            f"refusing the implicit fallback to {implicit}. Mark one entry \"default\": true."
        )
        return None
    _warn_once(
        f"No model catalog entry is marked default; falling back to the first entry ({implicit}). "
        f"Catalog order is silently deciding the platform default — mark one entry "
        f"\"default\": true, or set GATEWAY_STRICT_DEFAULT_ALIAS=true to refuse."
    )
    return implicit


def _warn_once(message: str) -> None:
    """Append + log a config warning at most once per cache generation.

    Dedup matters here: default_model_alias() runs on the hot path for every
    untargeted call, and a per-request log line would bury the signal it exists
    to raise.
    """
    if message in _warnings:
        return
    _warnings.append(message)
    logger.warning("llm_gateway.provider_config %s", message)


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


def compute_embedding_cost(alias: Optional[str], input_tokens: int) -> Optional[float]:
    """Cost for an embedding call, which has input tokens only.

    Separate from compute_estimated_cost deliberately. That function requires
    BOTH prices and returns None if either is missing — correct for chat, wrong
    here: an embedding model produces no output, so a catalog author has every
    reason to omit outputPricePerMtok. Reusing it would have produced a cost
    path that silently returns None for any realistically-configured embedding
    model, which is worse than having no cost path at all because it looks like
    it works.

    Embeddings are the highest-volume traffic on this gateway, so this is the
    largest cost line in the platform.
    """
    if not alias:
        return None
    try:
        entry = resolve_alias(alias)
    except ProviderConfigError:
        return None
    input_rate = _safe_price_per_mtok(entry.get("inputPricePerMtok"))
    if input_rate is None:
        return None
    return round((input_tokens * input_rate) / 1_000_000.0, 6)


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
    # Never expose a partially-written catalog to another gateway process. A
    # temp file in the same directory preserves atomic rename semantics.
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    payload = (json.dumps(models, indent=2) + "\n").encode("utf-8")
    with temp.open("wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)
    _loaded_catalog = None  # force re-read on next access → the change is live


@contextmanager
def _catalog_lock() -> Iterator[None]:
    """Serialize catalog mutations across threads and gateway processes."""
    path = _catalog_write_path().with_name(f".{_catalog_write_path().name}.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        try:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass
        try:
            yield
        finally:
            try:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except (ImportError, OSError):
                pass


def _clean_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    return {k: entry[k] for k in _MODEL_FIELDS if entry.get(k) is not None}


def add_model(entry: Dict[str, Any]) -> Dict[str, Any]:
    with _catalog_lock():
        global _loaded_catalog
        _loaded_catalog = None
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
    with _catalog_lock():
        global _loaded_catalog
        _loaded_catalog = None
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
    with _catalog_lock():
        global _loaded_catalog
        _loaded_catalog = None
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
