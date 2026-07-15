from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models import User, LocalCredential, UserTenantMembership
from app.auth.password import verify_password
from app.auth.jwt import create_access_token, create_service_token, decode_token
from app.auth.schemas import LoginRequest, LoginResponse, TokenUserOut
from app.auth.sso import (
    auth_mode,
    exchange_oidc_authorization_code,
    federated_identity_from_claims,
    oidc_authorization_url,
    sso_readiness,
    verify_oidc_id_token,
)
from app.auth.deps import require_super_admin
from app.audit.service import record_event
from pydantic import BaseModel, Field
import secrets

router = APIRouter(prefix="/auth", tags=["auth"])


async def active_tenant_ids(db: AsyncSession, user_id: str) -> list[str]:
    result = await db.execute(
        select(UserTenantMembership.tenant_id).where(
            UserTenantMembership.user_id == user_id,
            UserTenantMembership.status == "active",
        )
    )
    return sorted({str(value) for value in result.scalars().all() if value})


@router.post("/local/login", response_model=LoginResponse)
async def local_login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    if auth_mode() != "local":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Local password login is disabled while IAM_AUTH_MODE=oidc. Use the configured SSO provider.",
        )
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

    tenant_ids = await active_tenant_ids(db, user.id)
    token = create_access_token(user.id, user.email, user.is_super_admin, tenant_ids)
    await record_event(db, actor_user_id=user.id, event_type="local_login", payload={"email": user.email})

    return LoginResponse(
        access_token=token,
        user=TokenUserOut(id=user.id, email=user.email, display_name=user.display_name, is_super_admin=user.is_super_admin, tenant_ids=tenant_ids),
    )


class LoginUrlResponse(BaseModel):
    authorization_url: str
    state: str
    nonce: str


class OidcTokenLoginRequest(BaseModel):
    id_token: str = Field(..., min_length=20)
    nonce: str | None = Field(default=None, min_length=8, max_length=256)


class OidcCodeLoginRequest(BaseModel):
    code: str = Field(..., min_length=4)
    nonce: str | None = Field(default=None, min_length=8, max_length=256)


@router.get("/providers")
async def providers():
    return sso_readiness()


@router.get("/oidc/login-url", response_model=LoginUrlResponse)
async def oidc_login_url():
    readiness = sso_readiness()
    if not readiness["oidc"]["enabled"] or not readiness["oidc"]["configured"]:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="OIDC provider is not configured")
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    return LoginUrlResponse(
        authorization_url=oidc_authorization_url(state, nonce),
        state=state,
        nonce=nonce,
    )


async def _login_oidc_id_token(id_token: str, nonce: str | None, db: AsyncSession) -> LoginResponse:
    if auth_mode() != "oidc":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OIDC login is not enabled")
    try:
        claims = verify_oidc_id_token(id_token, nonce)
        identity = federated_identity_from_claims(claims)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    result = await db.execute(
        select(User).where(
            User.auth_provider == identity["provider"],
            User.external_subject == identity["subject"],
        )
    )
    user = result.scalar_one_or_none()
    if not user:
        result = await db.execute(select(User).where(User.email == identity["email"]))
        user = result.scalar_one_or_none()

    if user:
        user.email = identity["email"]
        user.auth_provider = identity["provider"]
        user.external_subject = identity["subject"]
        user.display_name = identity["display_name"]
        user.is_local_account = False
        user.metadata_ = {**(user.metadata_ or {}), "oidc": identity["metadata"]}
        if identity["is_super_admin"]:
            user.is_super_admin = True
        if user.status != "active":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is not active")
    else:
        user = User(
            email=identity["email"],
            display_name=identity["display_name"],
            auth_provider=identity["provider"],
            external_subject=identity["subject"],
            is_super_admin=identity["is_super_admin"],
            is_local_account=False,
            metadata_={"oidc": identity["metadata"]},
        )
        db.add(user)

    await db.commit()
    await db.refresh(user)

    tenant_ids = await active_tenant_ids(db, user.id)
    token = create_access_token(user.id, user.email, user.is_super_admin, tenant_ids)
    await record_event(
        db,
        actor_user_id=user.id,
        event_type="oidc_login",
        payload={"email": user.email, "issuer": identity["metadata"]["issuer"]},
    )
    await db.commit()

    return LoginResponse(
        access_token=token,
        user=TokenUserOut(id=user.id, email=user.email, display_name=user.display_name, is_super_admin=user.is_super_admin, tenant_ids=tenant_ids),
    )


@router.post("/oidc/token-login", response_model=LoginResponse)
async def oidc_token_login(body: OidcTokenLoginRequest, db: AsyncSession = Depends(get_db)):
    return await _login_oidc_id_token(body.id_token, body.nonce, db)


@router.post("/oidc/code-login", response_model=LoginResponse)
async def oidc_code_login(body: OidcCodeLoginRequest, db: AsyncSession = Depends(get_db)):
    if auth_mode() != "oidc":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OIDC login is not enabled")
    try:
        id_token = await exchange_oidc_authorization_code(body.code)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    return await _login_oidc_id_token(id_token, body.nonce, db)


# ── M11 follow-up — service-token mint ─────────────────────────────────────
#
# Long-lived JWT for service-to-service calls (workgraph → IAM, cf → IAM,
# etc.). Replaces the practice of passing 60-min admin user tokens around
# via env vars. Only super-admins can mint; the resulting token carries
# `kind=service`, `service_name=<svc>`, an explicit `scopes` list, and
# optionally `tenant_ids` for strict tenant-isolated deployments.

_VALID_SCOPES = {
    "read:reference-data",   # /capabilities, /users, /teams, /roles, ...
    "write:reference-data",  # service-owned reference sync such as /capabilities/reference/{id}
    "read:mcp-servers",      # /mcp-servers (incl. bearer tokens)
    "read:audit",            # /audit-events
    "publish:events",        # /api/v1/events/* (subscribe + emit)
    "authz:check",           # bounded service-side decisions for a tenant
    "governance:author",     # advisory governance attachment writes
    "governance:enforce",    # REQUIRED/BLOCKING governance writes
    "git:issue-credentials", # /internal/git/credentials/issue (Git broker, P0 #2)
}


class ServiceTokenRequest(BaseModel):
    service_name: str = Field(..., min_length=1, max_length=64)
    scopes:       list[str]
    tenant_ids:   list[str] = Field(default_factory=list)
    ttl_hours:    int = Field(default=24 * 30, ge=1, le=24 * 365)  # 1 hour to 1 year


class ServiceTokenResponse(BaseModel):
    access_token: str
    service_name: str
    scopes:       list[str]
    tenant_ids:   list[str]
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
    current_user: User = Depends(require_super_admin),
):
    invalid = [s for s in body.scopes if s not in _VALID_SCOPES]
    if invalid:
        raise HTTPException(status_code=400, detail=f"unknown scopes: {invalid}; valid={sorted(_VALID_SCOPES)}")
    if not body.scopes:
        raise HTTPException(status_code=400, detail="at least one scope is required")
    tenant_ids = sorted({tenant_id.strip() for tenant_id in body.tenant_ids if tenant_id.strip()})

    token = create_service_token(
        service_name=body.service_name,
        issued_by_user_id=current_user.id,
        scopes=body.scopes,
        tenant_ids=tenant_ids,
        ttl_hours=body.ttl_hours,
    )
    await record_event(
        db, actor_user_id=current_user.id, event_type="service_token_minted",
        payload={"service_name": body.service_name, "scopes": body.scopes, "tenant_ids": tenant_ids, "ttl_hours": body.ttl_hours},
    )
    await db.commit()
    return ServiceTokenResponse(
        access_token=token,
        service_name=body.service_name,
        scopes=body.scopes,
        tenant_ids=tenant_ids,
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
                is_super_admin=False,
                tenant_ids=list(payload.get("tenant_ids") or []),
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
            tenant_ids=list(payload.get("tenant_ids") or []),
        ),
    )
