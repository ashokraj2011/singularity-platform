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
# carry `is_super_admin=True` for read scopes today; tighten with explicit
# scope checks once the existing handlers learn to consume `scopes`.
class _ServicePrincipal:
    """Duck-types just enough of `User` for handlers that only read .id /
    .email / .is_super_admin (the common case for read endpoints)."""
    is_local_account = True
    status = "active"
    display_name = None

    def __init__(self, service_name: str, scopes: list[str], issued_by: str):
        self.id = f"service:{service_name}"
        self.email = f"{service_name}@service.local"
        self.is_super_admin = True
        self.service_name = service_name
        self.scopes = scopes
        self.issued_by = issued_by


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
            issued_by=payload.get("issued_by") or "",
        )

    result = await db.execute(select(User).where(User.id == sub))
    user = result.scalar_one_or_none()
    if not user or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")
    return user


async def require_super_admin(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.is_super_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Super admin required")
    return current_user
