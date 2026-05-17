"""
M37.2 — Python client for prompt-composer's SystemPrompt store.

Mirrors the TS @agentandtools/shared/system-prompts helper. Used by
Python services (context_memory_service, summarizer, etc.) to fetch
single-shot LLM prompts by key instead of hardcoding the string.

Behaviour:
  - Async, httpx-based
  - In-process cache, default 5min TTL
  - De-duplicates concurrent fetches per key (asyncio.Lock per key)
  - Stale-OK on composer outage when a prior value is cached
  - Raises only on cold-start with composer unreachable

Config (env, read on first call):
  PROMPT_COMPOSER_URL          required — http://prompt-composer:3004
  SYSTEM_PROMPT_CACHE_TTL_SEC  optional — default 300
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from typing import Optional

import httpx


@dataclass
class SystemPromptResult:
    key: str
    version: int
    content: str
    json_schema: Optional[dict]
    model_hint: Optional[str]


class _CacheEntry:
    __slots__ = ("fetched_at", "value")

    def __init__(self, fetched_at: float, value: SystemPromptResult) -> None:
        self.fetched_at = fetched_at
        self.value = value


_cache: dict[str, _CacheEntry] = {}
_locks: dict[str, asyncio.Lock] = {}


def _ttl_seconds() -> int:
    raw = os.getenv("SYSTEM_PROMPT_CACHE_TTL_SEC", "300")
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return 300


def _composer_url() -> str:
    v = (os.getenv("PROMPT_COMPOSER_URL") or "").strip()
    if not v:
        raise RuntimeError(
            "PROMPT_COMPOSER_URL is not set. SystemPrompt fetch requires the "
            "composer URL — set PROMPT_COMPOSER_URL=http://prompt-composer:3004 "
            "in container env."
        )
    return v.rstrip("/")


def _get_lock(key: str) -> asyncio.Lock:
    lock = _locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _locks[key] = lock
    return lock


async def _fetch_once(key: str, vars_payload: Optional[dict]) -> SystemPromptResult:
    base = _composer_url()
    if vars_payload is not None:
        url = f"{base}/api/v1/system-prompts/{key}/render"
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json={"vars": vars_payload})
    else:
        url = f"{base}/api/v1/system-prompts/{key}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url)

    if resp.status_code >= 400:
        body = resp.text[:500] if resp.text else ""
        raise RuntimeError(f"SystemPrompt fetch {key} -> {resp.status_code}: {body}")

    payload = resp.json()
    if not payload.get("success"):
        raise RuntimeError(f"SystemPrompt fetch {key} returned success=false")

    data = payload["data"]
    return SystemPromptResult(
        key=data["key"],
        version=int(data["version"]),
        content=data["content"],
        json_schema=data.get("jsonSchema"),
        model_hint=data.get("modelHint"),
    )


def _cache_key(key: str, vars_payload: Optional[dict]) -> str:
    if vars_payload is None:
        return key
    # Stable JSON: sort keys so order doesn't matter for cache hits.
    return f"{key}::{json.dumps(vars_payload, sort_keys=True)}"


async def get_system_prompt(
    key: str,
    vars_payload: Optional[dict] = None,
) -> SystemPromptResult:
    """
    Resolve a SystemPrompt by stable key.

        result = await get_system_prompt("context-fabric.context-compiler")
        # use result.content as the system message

    Optional `vars_payload` performs Mustache substitution on the composer
    side (POST /render); omit for a plain GET (faster, cached).
    """
    cache_key = _cache_key(key, vars_payload)
    ttl = _ttl_seconds()
    now = time.time()

    hit = _cache.get(cache_key)
    if hit and now - hit.fetched_at < ttl:
        return hit.value

    lock = _get_lock(cache_key)
    async with lock:
        # Re-check inside the lock (another caller may have populated it).
        hit = _cache.get(cache_key)
        if hit and time.time() - hit.fetched_at < ttl:
            return hit.value
        try:
            value = await _fetch_once(key, vars_payload)
            _cache[cache_key] = _CacheEntry(time.time(), value)
            return value
        except Exception:
            # Stale-OK if we have any prior value.
            if hit is not None:
                return hit.value
            raise


def invalidate_system_prompt_cache(key: Optional[str] = None) -> None:
    """Test/operator helper — clear cache for one key (or all keys)."""
    if key is None:
        _cache.clear()
        return
    for k in list(_cache.keys()):
        if k == key or k.startswith(f"{key}::"):
            del _cache[k]
