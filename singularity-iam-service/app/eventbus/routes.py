"""M11.e — IAM event-bus subscription HTTP routes."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, AnyHttpUrl, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import EventSubscription, EventDelivery, EventOutbox

router = APIRouter(prefix="/api/v1/events", tags=["events"])


class SubscriptionIn(BaseModel):
    subscriber_id: str = Field(..., min_length=1)
    event_pattern: str = Field(..., min_length=1)
    target_url:    AnyHttpUrl
    secret:        Optional[str] = None
    metadata:      Optional[dict] = None


class SubscriptionOut(BaseModel):
    id:            str
    subscriber_id: str
    event_pattern: str
    target_url:    str
    is_active:     bool
    created_at:    str

    class Config:
        from_attributes = True


@router.post("/subscriptions", response_model=SubscriptionOut, status_code=201)
async def create_subscription(body: SubscriptionIn, db: AsyncSession = Depends(get_db)):
    sub = EventSubscription(
        subscriber_id=body.subscriber_id,
        event_pattern=body.event_pattern,
        target_url=str(body.target_url),
        secret=body.secret,
        metadata_=body.metadata or {},
    )
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return SubscriptionOut(
        id=sub.id, subscriber_id=sub.subscriber_id, event_pattern=sub.event_pattern,
        target_url=sub.target_url, is_active=sub.is_active, created_at=sub.created_at.isoformat(),
    )


@router.get("/subscriptions")
async def list_subscriptions(
    subscriber_id: Optional[str] = Query(default=None),
    is_active:     Optional[bool] = Query(default=None),
    db:            AsyncSession = Depends(get_db),
):
    q = select(EventSubscription)
    if subscriber_id is not None:
        q = q.where(EventSubscription.subscriber_id == subscriber_id)
    if is_active is not None:
        q = q.where(EventSubscription.is_active.is_(is_active))
    rows = (await db.execute(q.order_by(EventSubscription.created_at.desc()))).scalars().all()
    items = [
        SubscriptionOut(
            id=r.id, subscriber_id=r.subscriber_id, event_pattern=r.event_pattern,
            target_url=r.target_url, is_active=r.is_active, created_at=r.created_at.isoformat(),
        ).model_dump()
        for r in rows
    ]
    return {"items": items, "total": len(items)}


@router.delete("/subscriptions/{sub_id}", status_code=204)
async def delete_subscription(sub_id: str, db: AsyncSession = Depends(get_db)):
    r = (await db.execute(select(EventSubscription).where(EventSubscription.id == sub_id))).scalar_one_or_none()
    if r is None:
        raise HTTPException(status_code=404, detail="subscription not found")
    await db.delete(r)
    await db.commit()


@router.get("/subscriptions/{sub_id}/deliveries")
async def list_deliveries(sub_id: str, db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(EventDelivery, EventOutbox)
        .join(EventOutbox, EventOutbox.id == EventDelivery.outbox_id)
        .where(EventDelivery.subscription_id == sub_id)
        .order_by(EventDelivery.created_at.desc())
        .limit(100)
    )).all()
    items = []
    for d, o in rows:
        items.append({
            "id":              d.id,
            "status":          d.status,
            "attempts":        d.attempts,
            "response_status": d.response_status,
            "delivered_at":    d.delivered_at.isoformat() if d.delivered_at else None,
            "last_error":      d.last_error,
            "event_name":      o.event_name,
            "trace_id":        o.trace_id,
            "subject_kind":    o.subject_kind,
            "subject_id":      o.subject_id,
            "emitted_at":      o.emitted_at.isoformat(),
        })
    return {"items": items, "total": len(items)}
