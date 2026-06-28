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
    tenant_ids: list[str] | None = None,
    ttl_hours: int = 24 * 30,    # 30 days default — service-to-service, not user
) -> str:
    """M11 follow-up — long-lived JWT for service-to-service calls.

    Distinguished from user tokens by `kind=service` and `sub=service:<name>`.
    Carries explicit `scopes` (e.g. ["read:reference-data"]) and optional
    `tenant_ids` so deps can check what the bearer is allowed to do, instead
    of relying on `is_super_admin`.
    """
    expire = datetime.now(timezone.utc) + timedelta(hours=ttl_hours)
    payload = {
        "sub":            f"service:{service_name}",
        "kind":           "service",
        "service_name":   service_name,
        "scopes":         list(scopes),
        "tenant_ids":     sorted({tenant_id.strip() for tenant_id in (tenant_ids or []) if tenant_id.strip()}),
        "issued_by":      issued_by_user_id,
        "exp":            expire,
        # SECURITY: service tokens carry NO is_super_admin — authorization is by
        # explicit `scopes` only (IAM's require_super_admin already rejects
        # service principals). Removed the compat bridge; consuming services must
        # gate on scopes, never on a service token's admin flag.
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def create_device_token(
    *,
    user_id: str,
    email: str,
    device_id: str,
    device_name: str,
    scopes: list[str],
    ttl_days: int = 90,
    token_kind: str = "device",
    tenant_id: str | None = None,
    runtime_type: str = "mcp",
    runtime_scope: str = "user",
    allowed_frame_types: list[str] | None = None,
    capability_tags: list[str] | None = None,
) -> str:
    """Long-lived JWT for a user's device or MCP runtime.

    Minted by `POST /api/v1/auth/device-token` after the user logs into the
    platform; stored in the laptop's OS keychain by the `singularity-mcp`
    CLI. Context Fabric's runtime bridge verifies these tokens to identify
    which runtime is on the other end of the socket.

    Wire-compat with the pseudo-IAM mint at `pseudo-iam-service/src/index.ts`:
    same claim shape (`kind:"device"`, `sub:user_id`, `device_id`,
    `device_name`, `email`, `scopes`) signed with the shared `JWT_SECRET`.
    """
    expire = datetime.now(timezone.utc) + timedelta(days=ttl_days)
    kind = "runtime" if token_kind == "runtime" else "device"
    payload = {
        "sub":          user_id,
        "kind":         kind,
        "email":        email,
        "device_id":    device_id,
        "device_name":  device_name,
        "scopes":       list(scopes),
        "exp":          expire,
        # SECURITY: device/runtime tokens carry NO is_super_admin — gating is by
        # `scopes` only, and these tokens are valid only on runtime-bridge /
        # device surfaces (user-facing service APIs reject kind=device|runtime).
    }
    if kind == "runtime":
        payload.update({
            "runtime_id": device_id,
            "runtime_type": runtime_type or "mcp",
            "runtime_scope": runtime_scope or "user",
            "allowed_frame_types": list(allowed_frame_types or ["tool-run", "model-run", "code-context", "invoke"]),
            "capability_tags": list(capability_tags or ["mcp", "tools", "llm"]),
        })
        if tenant_id:
            payload["tenant_id"] = tenant_id
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.PyJWTError as e:
        raise ValueError(f"Invalid token: {e}")
