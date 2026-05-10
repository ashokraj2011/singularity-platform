from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from app.models import AuditEvent


async def record_event(
    db: AsyncSession,
    event_type: str,
    actor_user_id: Optional[str] = None,
    capability_id: Optional[str] = None,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    payload: Optional[dict] = None,
    ip_address: Optional[str] = None,
    user_agent: Optional[str] = None,
) -> AuditEvent:
    event = AuditEvent(
        actor_user_id=actor_user_id,
        event_type=event_type,
        capability_id=capability_id,
        target_type=target_type,
        target_id=target_id,
        payload=payload or {},
        ip_address=ip_address,
        user_agent=user_agent,
    )
    db.add(event)
    await db.flush()
    return event
