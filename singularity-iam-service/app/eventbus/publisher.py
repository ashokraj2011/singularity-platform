"""M11.e — IAM event-bus publisher.

Writes a row into iam.event_outbox and triggers pg_notify so the dispatcher
picks it up immediately. Envelope shape matches workgraph's so subscribers
can consume any service uniformly.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models import EventOutbox

log = logging.getLogger(__name__)

EVENT_CHANNEL = "event_outbox_iam"


def _new_id() -> str:
    return str(uuid.uuid4())


async def publish_event(
    *,
    event_name: str,
    subject_kind: str,
    subject_id: str,
    trace_id: Optional[str] = None,
    actor: Optional[dict] = None,
    status: str = "emitted",
    correlation: Optional[dict] = None,
    payload: Optional[dict] = None,
    db: Optional[AsyncSession] = None,
) -> str:
    """Insert an event_outbox row and pg_notify the dispatcher.

    If `db` is supplied, runs in that session (caller controls commit). Else
    opens a fresh session and commits inline.
    """
    envelope = {
        "source_service": "iam",
        "trace_id":       trace_id,
        "subject":        {"kind": subject_kind, "id": subject_id},
        "actor":          actor,
        "status":         status,
        "started_at":     datetime.now(timezone.utc).isoformat(),
        "correlation":    correlation or {},
        "payload":        payload or {},
    }
    row_id = _new_id()

    async def _do(session: AsyncSession) -> None:
        session.add(EventOutbox(
            id=row_id,
            event_name=event_name,
            source_service="iam",
            trace_id=trace_id,
            subject_kind=subject_kind,
            subject_id=subject_id,
            envelope=envelope,
        ))
        await session.flush()
        # NOTIFY with the outbox id so the dispatcher can pick the row directly.
        # If pg_notify fails, the safety-sweep will still pick it up.
        try:
            await session.execute(text(f"SELECT pg_notify(:c, :p)").bindparams(c=EVENT_CHANNEL, p=row_id))
        except Exception as exc:
            log.warning("pg_notify failed: %s", exc)

    if db is not None:
        await _do(db)
    else:
        async with AsyncSessionLocal() as s:
            await _do(s)
            await s.commit()
    return row_id
