from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models import User
from app.auth.deps import get_current_user
from app.authz.resolver import check_authorization
from app.authz.schemas import (
    AuthzCheckRequest, AuthzCheckResponse, BulkCheckRequest, BulkCheckResponse,
)
from app.audit.service import record_event

router = APIRouter(prefix="/authz", tags=["authz"])


@router.post("/check", response_model=AuthzCheckResponse)
async def authz_check(
    body: AuthzCheckRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await check_authorization(
        db=db,
        user_id=body.user_id,
        capability_id=body.capability_id,
        action=body.action,
        requesting_capability_id=body.requesting_capability_id,
    )

    if not result.allowed:
        await record_event(
            db, actor_user_id=body.user_id, event_type="authorization_denied",
            capability_id=body.capability_id,
            payload={"action": body.action, "reason": result.reason,
                     "resource_type": body.resource_type, "resource_id": body.resource_id},
        )
        await db.commit()

    if result.source == "super_admin":
        await record_event(
            db, actor_user_id=body.user_id, event_type="super_admin_action",
            capability_id=body.capability_id,
            payload={"action": body.action, "resource_type": body.resource_type},
        )
        await db.commit()

    return AuthzCheckResponse(
        allowed=result.allowed,
        reason=result.reason,
        roles=result.roles,
        permissions=result.permissions,
        source=result.source,
    )


@router.post("/bulk-check", response_model=BulkCheckResponse)
async def authz_bulk_check(
    body: BulkCheckRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    results = []
    for check in body.checks:
        result = await check_authorization(
            db=db,
            user_id=body.user_id,
            capability_id=check.capability_id,
            action=check.action,
            requesting_capability_id=check.requesting_capability_id,
        )
        results.append(AuthzCheckResponse(
            allowed=result.allowed, reason=result.reason,
            roles=result.roles, permissions=result.permissions, source=result.source,
        ))
    return BulkCheckResponse(results=results)
