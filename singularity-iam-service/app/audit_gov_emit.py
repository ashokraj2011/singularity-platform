"""M22 / fan-out — fire-and-forget emitter to audit-governance-service.

Producers in IAM (auth.* / authz.decision / device-token mint+revoke) push a
single envelope into the central ledger so the platform has one canonical
audit feed. Failure of audit-gov MUST NOT block the request that produced the
event — we log a warn and move on.

This mirrors `mcp-server/src/lib/audit-gov-emit.ts` and
`agent-and-tools/apps/prompt-composer/src/lib/audit-gov-emit.ts` so all three
producers speak the same wire shape.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

import httpx

log = logging.getLogger(__name__)

_AUDIT_GOV_URL = os.environ.get("AUDIT_GOV_URL", "http://host.docker.internal:8500")
_TIMEOUT_SECONDS = 5.0


def emit_audit_event(
    *,
    kind: str,
    source_service: str = "iam",
    trace_id: Optional[str] = None,
    subject_type: Optional[str] = None,
    subject_id: Optional[str] = None,
    actor_id: Optional[str] = None,
    capability_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
    severity: str = "info",
    payload: Optional[dict[str, Any]] = None,
) -> None:
    """Fire-and-forget post into audit-gov.

    Callers must never `await` this; we schedule it on the event loop so it
    completes after the response is returned to the client.
    """
    if not _AUDIT_GOV_URL:
        return
    envelope = {
        "trace_id":       trace_id,
        "source_service": source_service,
        "kind":           kind,
        "subject_type":   subject_type,
        "subject_id":     subject_id,
        "actor_id":       actor_id,
        "capability_id":  capability_id,
        "tenant_id":      tenant_id,
        "severity":       severity,
        "payload":        payload or {},
    }
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        # No running loop (e.g. test sync context) — fall back to a one-shot
        # request synchronously. We still don't raise on failure.
        try:
            with httpx.Client(timeout=_TIMEOUT_SECONDS) as client:
                client.post(f"{_AUDIT_GOV_URL.rstrip('/')}/api/v1/events", json=envelope)
        except Exception as exc:
            log.warning("audit-gov emit %s failed: %s", kind, exc)
        return
    loop.create_task(_emit(envelope))


async def _emit(envelope: dict[str, Any]) -> None:
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            res = await client.post(
                f"{_AUDIT_GOV_URL.rstrip('/')}/api/v1/events", json=envelope,
            )
            if res.status_code >= 400:
                log.warning("audit-gov emit %s → %s: %s", envelope.get("kind"), res.status_code, res.text[:200])
    except Exception as exc:
        log.warning("audit-gov emit %s failed: %s", envelope.get("kind"), exc)
