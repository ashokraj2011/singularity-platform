from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models import User, UserTenantMembership
from app.auth.deps import require_authz_check, is_service_principal
from app.authz.resolver import check_authorization
from app.authz.schemas import AuthzCheckRequest, AuthzCheckResponse, BulkCheckRequest, BulkCheckResponse
from app.audit.service import record_event
from app.audit_gov_emit import emit_audit_event

router = APIRouter(prefix="/authz", tags=["authz"])


def _enforce_subject_scope(body: AuthzCheckRequest, current_user: User) -> None:
    if not body.tenant_id.strip():
        raise HTTPException(status_code=400, detail="tenant_id is required")
    if is_service_principal(current_user):
        tenant_ids = set(getattr(current_user, "tenant_ids", []) or [])
        if body.tenant_id not in tenant_ids:
            raise HTTPException(status_code=403, detail="Service token is not scoped for this tenant")
        return
    if body.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="User tokens may only check their own authorization")


def _response(result, tenant_id: str) -> AuthzCheckResponse:
    return AuthzCheckResponse(
        allowed=result.allowed,
        reason=result.reason,
        roles=result.roles,
        permissions=result.permissions,
        source=result.source,
        decision_id=result.decision_id,
        policy_version=result.policy_version,
        tenant_id=tenant_id,
    )


@router.get("/effective-access")
async def effective_access(
    tenant_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_authz_check),
):
    if is_service_principal(current_user):
        if tenant_id not in set(getattr(current_user, "tenant_ids", []) or []):
            raise HTTPException(status_code=403, detail="Service token is not scoped for this tenant")
        user_id = str(getattr(current_user, "issued_by", ""))
        if not user_id:
            raise HTTPException(status_code=403, detail="Service token has no delegated user context")
    else:
        user_id = current_user.id

    membership = (await db.execute(select(UserTenantMembership).where(
        UserTenantMembership.user_id == user_id,
        UserTenantMembership.tenant_id == tenant_id,
        UserTenantMembership.status == "active",
    ))).scalar_one_or_none()
    if not membership:
        raise HTTPException(status_code=403, detail="User is not an active member of this tenant")

    from app.authz.resolver import _get_platform_permissions
    permissions = sorted(await _get_platform_permissions(db, user_id, tenant_id))
    return {
        "user_id": user_id,
        "tenant_id": tenant_id,
        "permissions": permissions,
        "policy_version": "iam-authz-v2",
    }


@router.post("/check", response_model=AuthzCheckResponse)
async def authz_check(
    body: AuthzCheckRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_authz_check),
):
    _enforce_subject_scope(body, current_user)
    result = await check_authorization(
        db=db,
        user_id=body.user_id,
        capability_id=body.capability_id,
        action=body.action,
        tenant_id=body.tenant_id,
        requesting_capability_id=body.requesting_capability_id,
    )

    if not result.allowed:
        await record_event(
            db, actor_user_id=body.user_id, event_type="authorization_denied",
            capability_id=body.capability_id,
            payload={"action": body.action, "reason": result.reason,
                     "tenant_id": body.tenant_id, "resource_type": body.resource_type,
                     "resource_id": body.resource_id, "decision_id": result.decision_id},
        )
        await db.commit()

    if result.source == "super_admin":
        await record_event(
            db, actor_user_id=body.user_id, event_type="super_admin_action",
            capability_id=body.capability_id,
            payload={"action": body.action, "tenant_id": body.tenant_id, "resource_type": body.resource_type},
        )
        await db.commit()

    emit_audit_event(
        kind="iam.authz.decision",
        actor_id=body.user_id,
        subject_type="Capability",
        subject_id=body.capability_id,
        capability_id=body.capability_id,
        severity="info" if result.allowed else "warn",
        payload={
            "allowed": result.allowed,
            "reason": result.reason,
            "action": body.action,
            "tenant_id": body.tenant_id,
            "resource_type": body.resource_type,
            "resource_id": body.resource_id,
            "requesting_capability_id": body.requesting_capability_id,
            "roles": result.roles,
            "permissions": result.permissions,
            "source": result.source,
            "decision_id": result.decision_id,
            "policy_version": result.policy_version,
        },
    )
    return _response(result, body.tenant_id)


@router.post("/bulk-check", response_model=BulkCheckResponse)
async def authz_bulk_check(
    body: BulkCheckRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_authz_check),
):
    if not body.checks:
        return BulkCheckResponse(results=[])
    for check in body.checks:
        if check.user_id != body.user_id:
            raise HTTPException(status_code=400, detail="Bulk check user_id must match every check")
        _enforce_subject_scope(check, current_user)

    results = []
    for check in body.checks:
        result = await check_authorization(
            db=db,
            user_id=body.user_id,
            capability_id=check.capability_id,
            action=check.action,
            tenant_id=check.tenant_id,
            requesting_capability_id=check.requesting_capability_id,
        )
        results.append(_response(result, check.tenant_id))
    return BulkCheckResponse(results=results)
