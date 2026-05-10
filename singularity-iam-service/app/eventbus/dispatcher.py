"""M11.e — IAM event-bus dispatcher.

A single asyncpg connection LISTENs on `event_outbox_iam`. On every
notification (or every 30s safety sweep) we drain pending outbox rows, fan out
to matching subscriptions, and POST each delivery via httpx with HMAC signing
when the subscription has a `secret`.

Pattern matching: "agent.run.*" → matches "agent.run.completed" but NOT
"agent.run.tool.invocation.completed". A bare "*" matches everything.

Retry: a delivery is retried up to 5 times. The dispatcher only redrives on
the next sweep — no in-process scheduler.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

import asyncpg
import httpx
from sqlalchemy import select, update, and_
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.database import AsyncSessionLocal
from app.models import EventOutbox, EventSubscription, EventDelivery

log = logging.getLogger(__name__)

EVENT_CHANNEL          = "event_outbox_iam"
SWEEP_INTERVAL_SEC     = 30
MAX_DELIVERY_TRIES     = 5
DELIVERY_TIMEOUT_SEC   = 5

_listener: Optional[asyncpg.Connection] = None
_sweep_task: Optional[asyncio.Task] = None
_in_flight = False


def _pattern_to_regex(pattern: str) -> re.Pattern:
    if "*" not in pattern:
        return re.compile(rf"^{re.escape(pattern)}$")
    # `.` is a literal separator; `*` matches anything that isn't a `.`.
    parts = re.escape(pattern).replace(r"\*", "[^.]*")
    return re.compile(rf"^{parts}$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _asyncpg_dsn_from_sqlalchemy_url(url: str) -> str:
    """SQLAlchemy DATABASE_URL is `postgresql+asyncpg://...`. asyncpg wants
    plain `postgresql://...`."""
    if url.startswith("postgresql+asyncpg://"):
        return url.replace("postgresql+asyncpg://", "postgresql://", 1)
    return url


async def _process_outbox_row(outbox_id: str) -> None:
    async with AsyncSessionLocal() as s:
        row = (await s.execute(select(EventOutbox).where(EventOutbox.id == outbox_id))).scalar_one_or_none()
        if row is None or row.status == "dispatched":
            return

        subs_all = (await s.execute(select(EventSubscription).where(EventSubscription.is_active.is_(True)))).scalars().all()
        matching = [sub for sub in subs_all if _pattern_to_regex(sub.event_pattern).match(row.event_name)]

        # Insert delivery rows idempotently (upsert on the unique constraint).
        for sub in matching:
            stmt = pg_insert(EventDelivery).values(
                outbox_id=row.id,
                subscription_id=sub.id,
                status="queued",
            ).on_conflict_do_nothing(index_elements=["outbox_id", "subscription_id"])
            await s.execute(stmt)
        await s.commit()

        for sub in matching:
            d = (await s.execute(
                select(EventDelivery).where(
                    and_(EventDelivery.outbox_id == row.id, EventDelivery.subscription_id == sub.id),
                )
            )).scalar_one_or_none()
            if d is None or d.status in ("sent", "failed"):
                continue
            await _deliver_one(d, sub, row, s)
            await s.commit()

        # Mark dispatched if no queued deliveries remain.
        remaining = (await s.execute(
            select(EventDelivery).where(
                and_(EventDelivery.outbox_id == row.id, EventDelivery.status == "queued"),
            )
        )).scalars().first()
        if remaining is None:
            await s.execute(
                update(EventOutbox)
                .where(EventOutbox.id == row.id)
                .values(status="dispatched", last_attempt_at=_now(), attempts=EventOutbox.attempts + 1)
            )
            await s.commit()


async def _deliver_one(d: EventDelivery, sub: EventSubscription, row: EventOutbox, s) -> None:
    body = json.dumps({"event_name": row.event_name, "envelope": row.envelope}, separators=(",", ":"))
    headers = {
        "content-type":      "application/json",
        "x-event-name":      row.event_name,
        "x-event-outbox-id": row.id,
    }
    if sub.secret:
        sig = hmac.new(sub.secret.encode(), body.encode(), hashlib.sha256).hexdigest()
        headers["x-event-signature"] = f"sha256={sig}"

    new_status = "failed"
    response_status: Optional[int] = None
    error: Optional[str] = None
    try:
        async with httpx.AsyncClient(timeout=DELIVERY_TIMEOUT_SEC) as client:
            r = await client.post(sub.target_url, content=body, headers=headers)
        response_status = r.status_code
        if 200 <= r.status_code < 300:
            new_status = "sent"
        else:
            error = f"target returned HTTP {r.status_code}"
    except Exception as exc:
        error = str(exc)

    if new_status != "sent" and (d.attempts + 1) < MAX_DELIVERY_TRIES:
        new_status = "queued"

    await s.execute(
        update(EventDelivery)
        .where(EventDelivery.id == d.id)
        .values(
            status=new_status,
            attempts=EventDelivery.attempts + 1,
            last_attempt_at=_now(),
            last_error=error,
            delivered_at=_now() if new_status == "sent" else None,
            response_status=response_status,
        )
    )


async def _sweep_loop() -> None:
    global _in_flight
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_SEC)
        if _in_flight:
            continue
        _in_flight = True
        try:
            async with AsyncSessionLocal() as s:
                rows = (await s.execute(
                    select(EventOutbox.id).where(EventOutbox.status == "pending").order_by(EventOutbox.emitted_at.asc()).limit(50)
                )).scalars().all()
            for rid in rows:
                try:
                    await _process_outbox_row(rid)
                except Exception as exc:
                    log.warning("dispatcher row %s failed: %s", rid, exc)
        finally:
            _in_flight = False


async def _on_notification(_conn, _pid, _channel: str, payload: str) -> None:
    if not payload:
        return
    try:
        await _process_outbox_row(payload)
    except Exception as exc:
        log.warning("dispatcher notify %s failed: %s", payload, exc)


async def start_dispatcher() -> None:
    """Open dedicated LISTEN connection + start safety-sweep task."""
    global _listener, _sweep_task
    dsn_sqla = os.environ.get("DATABASE_URL", "postgresql+asyncpg://singularity:singularity@localhost:5432/singularity_iam")
    dsn = _asyncpg_dsn_from_sqlalchemy_url(dsn_sqla)
    try:
        _listener = await asyncpg.connect(dsn=dsn)
        await _listener.add_listener(EVENT_CHANNEL, _on_notification)
    except Exception as exc:
        log.warning("eventbus dispatcher couldn't open LISTEN connection: %s", exc)
        _listener = None

    _sweep_task = asyncio.create_task(_sweep_loop())
    # Drain anything pending at startup.
    try:
        async with AsyncSessionLocal() as s:
            rows = (await s.execute(
                select(EventOutbox.id).where(EventOutbox.status == "pending").order_by(EventOutbox.emitted_at.asc()).limit(100)
            )).scalars().all()
        for rid in rows:
            await _process_outbox_row(rid)
    except Exception as exc:
        log.warning("eventbus dispatcher initial drain failed: %s", exc)
    log.info("[eventbus] dispatcher listening on '%s'; safety sweep every %ds", EVENT_CHANNEL, SWEEP_INTERVAL_SEC)


async def stop_dispatcher() -> None:
    global _listener, _sweep_task
    if _sweep_task:
        _sweep_task.cancel()
        _sweep_task = None
    if _listener:
        try:
            await _listener.remove_listener(EVENT_CHANNEL, _on_notification)
            await _listener.close()
        except Exception:
            pass
        _listener = None
