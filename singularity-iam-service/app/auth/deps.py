from typing import Any

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models import User
from app.auth.jwt import decode_token

bearer = HTTPBearer()

# M11 follow-up — synthetic principal returned for service-token callers.
# Lets reference-data endpoints accept either a real user JWT or a service
# token without each route having to know the difference. Service principals
# are never super-admins; privileged service operations must check explicit
# scopes in a dedicated helper.
class _ServicePrincipal:
    """Duck-types just enough of `User` for handlers that only read .id /
    .email / .is_super_admin (the common case for read endpoints)."""
    is_local_account = True
    status = "active"
    display_name = None

    def __init__(self, service_name: str, scopes: list[str], tenant_ids: list[str], issued_by: str):
        self.id = f"service:{service_name}"
        self.email = f"{service_name}@service.local"
        self.is_super_admin = False
        self.service_name = service_name
        self.scopes = scopes
        self.tenant_ids = tenant_ids
        self.issued_by = issued_by


def is_service_principal(current_user: Any) -> bool:
    return bool(
        getattr(current_user, "service_name", None)
        or str(getattr(current_user, "id", "")).startswith("service:")
    )


def has_service_scope(current_user: Any, scope: str) -> bool:
    return is_service_principal(current_user) and scope in set(getattr(current_user, "scopes", None) or [])


def assert_super_admin_or_service_scope(current_user: Any, scope: str) -> None:
    if has_service_scope(current_user, scope):
        return
    if is_service_principal(current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Service token requires scope '{scope}'",
        )
    if not getattr(current_user, "is_super_admin", False):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Super admin required")


def assert_real_user_or_service_scope(current_user: Any, scope: str) -> None:
    if not is_service_principal(current_user):
        return
    if has_service_scope(current_user, scope):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=f"Service token requires scope '{scope}'",
    )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    try:
        payload = decode_token(credentials.credentials)
        sub: str = payload["sub"]
    except (ValueError, KeyError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    # M11 — service tokens have sub="service:<name>" + kind="service" and don't
    # map to a User row. Return a synthetic principal that quacks like one.
    if payload.get("kind") == "service" and sub.startswith("service:"):
        return _ServicePrincipal(             # type: ignore[return-value]
            service_name=payload.get("service_name") or sub.removeprefix("service:"),
            scopes=payload.get("scopes") or [],
            tenant_ids=payload.get("tenant_ids") or [],
            issued_by=payload.get("issued_by") or "",
        )

    result = await db.execute(select(User).where(User.id == sub))
    user = result.scalar_one_or_none()
    if not user or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")
    return user


async def require_real_user(current_user: User = Depends(get_current_user)) -> User:
    if is_service_principal(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User token required")
    return current_user


async def require_reference_read(current_user: User = Depends(get_current_user)) -> User:
    assert_real_user_or_service_scope(current_user, "read:reference-data")
    return current_user


async def require_authz_check(current_user: User = Depends(get_current_user)) -> User:
    """Permit human self-checks or explicitly scoped service decisions."""
    if is_service_principal(current_user):
        assert_super_admin_or_service_scope(current_user, "authz:check")
    return current_user


async def require_git_credential_issue(current_user: User = Depends(get_current_user)) -> User:
    # SERVICE-ONLY (stricter than the reference deps): the Git broker mints + returns
    # live GitHub tokens, so only a service principal carrying the explicit scope may
    # call it — a logged-in real user must NOT be able to issue credentials directly.
    if not has_service_scope(current_user, "git:issue-credentials"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Service token with scope 'git:issue-credentials' required",
        )
    return current_user


async def require_mcp_server_read(current_user: User = Depends(get_current_user)) -> User:
    assert_real_user_or_service_scope(current_user, "read:mcp-servers")
    return current_user


async def require_audit_read(current_user: User = Depends(get_current_user)) -> User:
    assert_real_user_or_service_scope(current_user, "read:audit")
    return current_user


async def require_event_publish(current_user: User = Depends(get_current_user)) -> User:
    assert_real_user_or_service_scope(current_user, "publish:events")
    return current_user


async def require_super_admin(current_user: User = Depends(get_current_user)) -> User:
    if is_service_principal(current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Super admin user required; service tokens must use a "
                "dedicated scoped endpoint instead of inheriting blanket admin power"
            ),
        )
    if not current_user.is_super_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Super admin required")
    return current_user
