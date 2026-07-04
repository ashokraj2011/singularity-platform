"""Cached client for the llm-gateway model catalog.

Exposes each model alias's context-window size so the governed loop can size
the code-context budget to the model that will actually run the stage, instead
of a static 7000 (code-context hardening D1).

Mirrors llm_client.py's gateway env config. Best-effort + cached: a gateway
hiccup must never block a turn, so failures return None and callers fall back
to a static default budget.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Awaitable, Callable, Optional

import httpx

from ..response_json import response_json_object
from .env_config import bounded_float_env

log = logging.getLogger(__name__)

_GATEWAY_URL = os.environ.get("LLM_GATEWAY_URL", "http://llm-gateway:8001").rstrip("/")
_GATEWAY_BEARER = os.environ.get("LLM_GATEWAY_BEARER", "")
_TTL_SEC = bounded_float_env(
    "LLM_MODEL_CATALOG_TTL_SEC",
    default=300.0,
    min_value=1.0,
    max_value=24.0 * 60.0 * 60.0,
    logger=log,
)
_TIMEOUT_SEC = bounded_float_env(
    "LLM_MODEL_CATALOG_TIMEOUT_SEC",
    default=5.0,
    min_value=1.0,
    max_value=300.0,
    logger=log,
)

# key (model id / model / label) → context_window_tokens. Cached across calls.
_cache: dict[str, Any] = {"by_key": {}, "expires_at": 0.0}


async def _fetch_catalog() -> dict[str, int]:
    """GET {gateway}/llm/models and map every alias to its context window."""
    url = f"{_GATEWAY_URL}/llm/models"
    headers: dict[str, str] = {}
    if _GATEWAY_BEARER:
        headers["authorization"] = f"Bearer {_GATEWAY_BEARER}"
    async with httpx.AsyncClient(timeout=_TIMEOUT_SEC) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        body = response_json_object(resp, "LLM gateway model catalog")
    out: dict[str, int] = {}
    for entry in (body or {}).get("models", []) or []:
        if not isinstance(entry, dict):
            continue
        win = entry.get("contextWindowTokens")
        if not isinstance(win, int) or win <= 0:
            continue
        for key in (entry.get("id"), entry.get("model"), entry.get("label")):
            if isinstance(key, str) and key:
                out[key] = win
    return out


async def context_window_for(
    model_alias: Optional[str],
    *,
    _fetcher: Optional[Callable[[], Awaitable[dict[str, int]]]] = None,
    _now: Optional[Callable[[], float]] = None,
) -> Optional[int]:
    """Return the model's context-window token count, or None when unknown.

    Cached for ``_TTL_SEC``. Never raises — gateway/transport errors leave any
    existing cache in place and return None on a cold miss. ``_fetcher`` / ``_now``
    are test seams.
    """
    if not model_alias:
        return None
    clock = _now or time.monotonic
    now = clock()
    if not _cache["by_key"] or now >= _cache["expires_at"]:
        fetch = _fetcher or _fetch_catalog
        try:
            fetched = await fetch()
            if fetched:
                _cache["by_key"] = fetched
                _cache["expires_at"] = now + _TTL_SEC
        except Exception:  # noqa: BLE001 — best-effort; keep stale cache if any
            if not _cache["by_key"]:
                return None
    return _cache["by_key"].get(model_alias)
