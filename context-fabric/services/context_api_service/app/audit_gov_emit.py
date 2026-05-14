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
AUDIT_GOV_SERVICE_TOKEN = os.environ.get("AUDIT_GOV_SERVICE_TOKEN", "")
TIMEOUT_S = 5.0


async def _post(payload: dict[str, Any]) -> None:
    if not AUDIT_GOV_URL:
        return
    url = AUDIT_GOV_URL.rstrip("/") + "/api/v1/events"
    headers = {}
    if AUDIT_GOV_SERVICE_TOKEN:
        headers["Authorization"] = f"Bearer {AUDIT_GOV_SERVICE_TOKEN}"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            res = await client.post(url, json=payload, headers=headers)
            if res.status_code >= 400:
                log.warning(
                    "audit-gov emit %s -> %s: %s",
                    payload.get("kind"), res.status_code, res.text[:200],
                )
    except Exception as err:
        log.warning("audit-gov emit %s failed: %s", payload.get("kind"), err)


def _build_body(
    *, kind: str, source_service: str, trace_id, subject_type, subject_id,
    actor_id, capability_id, tenant_id, severity, payload,
) -> dict[str, Any]:
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
    return body


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
    """Fire-and-forget — schedule the POST without awaiting it.

    The default emit path. Failures land on stderr only; the request keeps
    running. Used everywhere we want telemetry but cannot afford to block
    the hot path on audit-gov.
    """
    body = _build_body(
        kind=kind, source_service=source_service, trace_id=trace_id,
        subject_type=subject_type, subject_id=subject_id, actor_id=actor_id,
        capability_id=capability_id, tenant_id=tenant_id, severity=severity,
        payload=payload,
    )
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_post(body))
    except RuntimeError:
        asyncio.run(_post(body))


# M28 governance-1 — strict variant. Awaits the POST and RAISES on failure
# so fail_closed callers can block execution when audit-gov isn't healthy.
# Default callers should keep using emit_audit_event (fire-and-forget).
class AuditGovUnavailable(Exception):
    """Raised by emit_audit_event_strict when the producer cannot confirm
    audit-gov accepted the event. Used by governance_mode=fail_closed."""


async def emit_audit_event_strict(
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
    """Await audit-gov emission and raise AuditGovUnavailable on failure.

    Only callers that want to gate execution on audit-gov health (i.e.
    governance_mode=fail_closed) should use this. Everyone else uses
    emit_audit_event (fire-and-forget).
    """
    if not AUDIT_GOV_URL:
        raise AuditGovUnavailable("AUDIT_GOV_URL is unset")
    body = _build_body(
        kind=kind, source_service=source_service, trace_id=trace_id,
        subject_type=subject_type, subject_id=subject_id, actor_id=actor_id,
        capability_id=capability_id, tenant_id=tenant_id, severity=severity,
        payload=payload,
    )
    url = AUDIT_GOV_URL.rstrip("/") + "/api/v1/events"
    headers = {}
    if AUDIT_GOV_SERVICE_TOKEN:
        headers["Authorization"] = f"Bearer {AUDIT_GOV_SERVICE_TOKEN}"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            res = await client.post(url, json=body, headers=headers)
            if res.status_code >= 400:
                raise AuditGovUnavailable(
                    f"audit-gov returned {res.status_code}: {res.text[:200]}"
                )
    except AuditGovUnavailable:
        raise
    except Exception as err:
        raise AuditGovUnavailable(f"audit-gov unreachable: {err}") from err
