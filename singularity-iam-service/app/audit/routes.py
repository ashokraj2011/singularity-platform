from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.database import get_db
from app.models import AuditEvent, User
from app.auth.deps import get_current_user
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

router = APIRouter(prefix="/audit-events", tags=["audit"])


class AuditEventOut(BaseModel):
    id: str
    actor_user_id: Optional[str]
    event_type: str
    capability_id: Optional[str]
    target_type: Optional[str]
    target_id: Optional[str]
    payload: dict
    ip_address: Optional[str]
    user_agent: Optional[str]
    created_at: datetime

    model_config = {"from_attributes": True}


class PageResponse(BaseModel):
    items: list[AuditEventOut]
    total: int
    page: int
    size: int


@router.get("", response_model=PageResponse)
async def list_audit_events(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=200),
    event_type: Optional[str] = None,
    capability_id: Optional[str] = None,
    actor_user_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = select(AuditEvent)
    if event_type:
        q = q.where(AuditEvent.event_type == event_type)
    if capability_id:
        q = q.where(AuditEvent.capability_id == capability_id)
    if actor_user_id:
        q = q.where(AuditEvent.actor_user_id == actor_user_id)

    total_result = await db.execute(select(func.count()).select_from(q.subquery()))
    total = total_result.scalar_one()

    q = q.order_by(AuditEvent.created_at.desc()).offset((page - 1) * size).limit(size)
    result = await db.execute(q)
    items = result.scalars().all()
    return PageResponse(items=list(items), total=total, page=page, size=size)
