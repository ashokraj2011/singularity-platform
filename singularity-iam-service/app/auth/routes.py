from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models import User, LocalCredential
from app.auth.password import verify_password
from app.auth.jwt import create_access_token, create_service_token, decode_token
from app.auth.schemas import LoginRequest, LoginResponse, TokenUserOut
from app.auth.deps import get_current_user
from app.audit.service import record_event
from pydantic import BaseModel, Field

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/local/login", response_model=LoginResponse)
async def local_login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(User).where(User.email == body.email, User.is_local_account == True)  # noqa: E712
    )
    user = result.scalar_one_or_none()

    if not user:
        await record_event(db, event_type="failed_login", payload={"email": body.email, "reason": "user_not_found"})
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    cred_result = await db.execute(select(LocalCredential).where(LocalCredential.user_id == user.id))
    cred = cred_result.scalar_one_or_none()

    if not cred or not verify_password(body.password, cred.password_hash):
        await record_event(db, event_type="failed_login", payload={"email": body.email, "reason": "bad_password"})
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    if user.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is not active")

    cred.last_login_at = datetime.now(timezone.utc)
    await db.commit()

    token = create_access_token(user.id, user.email, user.is_super_admin)
    await record_event(db, actor_user_id=user.id, event_type="local_login", payload={"email": user.email})

    return LoginResponse(
        access_token=token,
        user=TokenUserOut(id=user.id, email=user.email, display_name=user.display_name, is_super_admin=user.is_super_admin),
    )


# ── M11 follow-up — service-token mint ─────────────────────────────────────
#
# Long-lived JWT for service-to-service calls (workgraph → IAM, cf → IAM,
# etc.). Replaces the practice of passing 60-min admin user tokens around
# via env vars. Only super-admins can mint; the resulting token carries
# `kind=service`, `service_name=<svc>`, and an explicit `scopes` list.

_VALID_SCOPES = {
    "read:reference-data",   # /capabilities, /users, /teams, /roles, ...
    "read:mcp-servers",      # /mcp-servers (incl. bearer tokens)
    "read:audit",            # /audit-events
    "publish:events",        # /api/v1/events/* (subscribe + emit)
}


class ServiceTokenRequest(BaseModel):
    service_name: str = Field(..., min_length=1, max_length=64)
    scopes:       list[str]
    ttl_hours:    int = Field(default=24 * 30, ge=1, le=24 * 365)  # 1 hour to 1 year


class ServiceTokenResponse(BaseModel):
    access_token: str
    service_name: str
    scopes:       list[str]
    expires_in_hours: int


class VerifyRequest(BaseModel):
    token: str | None = None


class VerifyResponse(BaseModel):
    valid: bool
    user: TokenUserOut | None = None
    reason: str | None = None


@router.post("/service-token", response_model=ServiceTokenResponse, status_code=201)
async def mint_service_token(
    body: ServiceTokenRequest,
    db:   AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not current_user.is_super_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super-admin required to mint service tokens")
    invalid = [s for s in body.scopes if s not in _VALID_SCOPES]
    if invalid:
        raise HTTPException(status_code=400, detail=f"unknown scopes: {invalid}; valid={sorted(_VALID_SCOPES)}")
    if not body.scopes:
        raise HTTPException(status_code=400, detail="at least one scope is required")

    token = create_service_token(
        service_name=body.service_name,
        issued_by_user_id=current_user.id,
        scopes=body.scopes,
        ttl_hours=body.ttl_hours,
    )
    await record_event(
        db, actor_user_id=current_user.id, event_type="service_token_minted",
        payload={"service_name": body.service_name, "scopes": body.scopes, "ttl_hours": body.ttl_hours},
    )
    await db.commit()
    return ServiceTokenResponse(
        access_token=token,
        service_name=body.service_name,
        scopes=body.scopes,
        expires_in_hours=body.ttl_hours,
    )


@router.post("/verify", response_model=VerifyResponse)
async def verify_token(body: VerifyRequest, db: AsyncSession = Depends(get_db)):
    """Validate a bearer token for services that use IAM introspection.

    Pseudo-IAM has exposed this route for a while, and Workgraph prefers it
    before falling back to /me. Real IAM should offer the same contract so
    callers do not depend on pseudo-only behavior.
    """
    if not body.token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")

    try:
        payload = decode_token(body.token)
    except ValueError as exc:
        return VerifyResponse(valid=False, reason=str(exc))

    sub = str(payload.get("sub") or "")
    if payload.get("kind") == "service" and sub.startswith("service:"):
        service_name = str(payload.get("service_name") or sub.removeprefix("service:"))
        return VerifyResponse(
            valid=True,
            user=TokenUserOut(
                id=sub,
                email=f"{service_name}@service.local",
                display_name=service_name,
                is_super_admin=bool(payload.get("is_super_admin", True)),
            ),
        )

    result = await db.execute(select(User).where(User.id == sub))
    user = result.scalar_one_or_none()
    if not user or user.status != "active":
        return VerifyResponse(valid=False, reason="User not found or inactive")

    return VerifyResponse(
        valid=True,
        user=TokenUserOut(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            is_super_admin=user.is_super_admin,
        ),
    )

