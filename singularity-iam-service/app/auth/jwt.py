from datetime import datetime, timedelta, timezone
import jwt
from app.config import settings


def create_access_token(user_id: str, email: str, is_super_admin: bool) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.JWT_EXPIRE_MINUTES)
    payload = {
        "sub": user_id,
        "email": email,
        "is_super_admin": is_super_admin,
        "exp": expire,
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def create_service_token(
    *,
    service_name: str,
    issued_by_user_id: str,
    scopes: list[str],
    ttl_hours: int = 24 * 30,    # 30 days default — service-to-service, not user
) -> str:
    """M11 follow-up — long-lived JWT for service-to-service calls.

    Distinguished from user tokens by `kind=service` and `sub=service:<name>`.
    Carries explicit `scopes` (e.g. ["read:reference-data"]) so deps can
    check what the bearer is allowed to do, instead of relying on
    `is_super_admin`.
    """
    expire = datetime.now(timezone.utc) + timedelta(hours=ttl_hours)
    payload = {
        "sub":            f"service:{service_name}",
        "kind":           "service",
        "service_name":   service_name,
        "scopes":         list(scopes),
        "issued_by":      issued_by_user_id,
        "exp":            expire,
        # Mark super-admin so existing deps that gate on it keep working until
        # we add proper scope enforcement.
        "is_super_admin": True,
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.PyJWTError as e:
        raise ValueError(f"Invalid token: {e}")
