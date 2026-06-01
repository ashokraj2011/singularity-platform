"""
M11.a — self-register the LLM gateway with platform-registry.

Mirrors mcp-server's register.ts and the sibling context-fabric services
(context_memory / metrics_ledger / context_api each ship their own copy).
The gateway previously borrowed context_memory_service's helper via a
cross-service import, but the gateway Docker image never copies that
service, so the import always failed and registration silently no-op'd.
This self-contained copy lives inside the gateway's own package, so it is
present in the image (Dockerfile copies services/llm_gateway_service).

Lightweight: one POST on FastAPI startup, then a heartbeat every 60s. No
external deps beyond httpx (already vendored for the providers). If
PLATFORM_REGISTRY_URL is unset or unreachable, all calls become silent
no-ops so the gateway still starts cleanly when running standalone /
locally.
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
            res = await client.post(f"{url}{path}", json=payload, headers=_headers())
            if res.status_code >= 400:
                # Surface 4xx (e.g. a schema-rejected payload) instead of
                # swallowing it — registration bugs are otherwise invisible.
                log.warning(
                    "platform-registry %s returned %s: %s",
                    path, res.status_code, res.text[:200],
                )
    except Exception as exc:  # noqa: BLE001
        log.warning("platform-registry call %s failed: %s", path, exc)


async def _heartbeat_loop(service_name: str, interval_sec: int) -> None:
    while True:
        await asyncio.sleep(interval_sec)
        await _post(f"/api/v1/services/{service_name}/heartbeat")


async def start_self_registration(payload: dict[str, Any], heartbeat_sec: int = 60) -> None:
    """Call once on FastAPI startup. Fires initial register + heartbeat task."""
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


def build_registration_payload() -> dict[str, Any]:
    """Assemble the gateway's registration payload from env.

    - service_name: defaults to "llm-gateway"; override via
      LLM_GATEWAY_SERVICE_NAME so a developer can run a LOCAL gateway under
      a distinct name (e.g. "llm-gateway-local") pointing at a shared
      registry without clobbering the cluster row.
    - base_url: PUBLIC_BASE_URL (the address other services should call) —
      same convention as mcp-server.
    - auth_mode: "bearer-static" when LLM_GATEWAY_BEARER is set (the gateway
      gates calls on a static bearer), else "none". MUST be one of the
      registry's accepted enum values — "bearer" (the old value) is invalid
      and is rejected by the registry schema with a 400.
    """
    service_name = os.environ.get("LLM_GATEWAY_SERVICE_NAME", "llm-gateway")
    base_url = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8001")
    auth_mode = "bearer-static" if os.environ.get("LLM_GATEWAY_BEARER") else "none"
    return {
        "service_name": service_name,
        "display_name": "Singularity LLM Gateway",
        "version":      "0.1.0",
        "base_url":     base_url,
        "health_path":  "/health",
        "auth_mode":    auth_mode,
        "owner_team":   "context-fabric",
        "metadata":     {"layer": "optimization", "role": "llm-gateway"},
        "capabilities": [
            {"capability_key": "llm.chat",       "description": "Chat completions across all providers"},
            {"capability_key": "llm.embeddings", "description": "Embeddings across all providers"},
        ],
    }
