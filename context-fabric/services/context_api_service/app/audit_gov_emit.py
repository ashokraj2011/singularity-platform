"""
M22 — fire-and-forget emitter for the audit-governance-service.

Producers should NEVER await this — emission failures must not block the
request handler. Errors land on stderr only. Set AUDIT_GOV_URL="" to
disable.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

import httpx

log = logging.getLogger(__name__)

AUDIT_GOV_URL = os.environ.get("AUDIT_GOV_URL", "http://host.docker.internal:8500")
TIMEOUT_S = 5.0


async def _post(payload: dict[str, Any]) -> None:
    if not AUDIT_GOV_URL:
        return
    url = AUDIT_GOV_URL.rstrip("/") + "/api/v1/events"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            res = await client.post(url, json=payload)
            if res.status_code >= 400:
                log.warning(
                    "audit-gov emit %s -> %s: %s",
                    payload.get("kind"), res.status_code, res.text[:200],
                )
    except Exception as err:
        log.warning("audit-gov emit %s failed: %s", payload.get("kind"), err)


def emit_audit_event(
    *,
    kind: str,
    source_service: str = "context-fabric",
    trace_id: Optional[str] = None,
    subject_type: Optional[str] = None,
    subject_id: Optional[str] = None,
    actor_id: Optional[str] = None,
    capability_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
    severity: str = "info",
    payload: Optional[dict[str, Any]] = None,
) -> None:
    """Fire-and-forget — schedule the POST without awaiting it."""
    body: dict[str, Any] = {
        "source_service": source_service,
        "kind":           kind,
        "severity":       severity,
        "payload":        payload or {},
    }
    if trace_id:      body["trace_id"]      = trace_id
    if subject_type:  body["subject_type"]  = subject_type
    if subject_id:    body["subject_id"]    = subject_id
    if actor_id:      body["actor_id"]      = actor_id
    if capability_id: body["capability_id"] = capability_id
    if tenant_id:     body["tenant_id"]     = tenant_id
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_post(body))
    except RuntimeError:
        # No running loop — sync caller. Best-effort: fire in a fresh loop.
        asyncio.run(_post(body))
