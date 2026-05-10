"""
M11.a — self-register with platform-registry.

Lightweight: one POST on FastAPI startup, then a heartbeat every 60s. No
external deps beyond httpx (already vendored). If PLATFORM_REGISTRY_URL is
unset or unreachable, all calls become silent no-ops so the service still
starts cleanly when running standalone.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx

log = logging.getLogger(__name__)
_heartbeat_task: asyncio.Task | None = None


def _registry_url() -> str | None:
    url = os.environ.get("PLATFORM_REGISTRY_URL", "").rstrip("/")
    return url or None


def _headers() -> dict[str, str]:
    h: dict[str, str] = {"content-type": "application/json"}
    tok = os.environ.get("PLATFORM_REGISTER_TOKEN")
    if tok:
        h["authorization"] = f"Bearer {tok}"
    return h


async def _post(path: str, payload: dict[str, Any] | None = None, timeout: float = 5.0) -> None:
    url = _registry_url()
    if not url:
        return
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            await client.post(f"{url}{path}", json=payload, headers=_headers())
    except Exception as exc:  # noqa: BLE001
        log.warning("platform-registry call %s failed: %s", path, exc)


async def _heartbeat_loop(service_name: str, interval_sec: int) -> None:
    while True:
        await asyncio.sleep(interval_sec)
        await _post(f"/api/v1/services/{service_name}/heartbeat")


async def start_self_registration(payload: dict[str, Any], heartbeat_sec: int = 60) -> None:
    """Call once on FastAPI startup. Fire initial register + heartbeat task."""
    global _heartbeat_task
    if _registry_url() is None:
        log.info("PLATFORM_REGISTRY_URL not set; self-registration disabled")
        return
    await _post("/api/v1/register", payload)
    if _heartbeat_task is None:
        _heartbeat_task = asyncio.create_task(_heartbeat_loop(payload["service_name"], heartbeat_sec))


async def stop_self_registration() -> None:
    global _heartbeat_task
    if _heartbeat_task is not None:
        _heartbeat_task.cancel()
        _heartbeat_task = None
