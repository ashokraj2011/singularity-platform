"""M11 follow-up — IAM service-token bootstrap (cf side).

Mirrors workgraph's getIamServiceToken(): logs in with bootstrap creds, mints
a 30-day service token, caches it in process memory, refreshes ~24h before
expiry. Replaces the practice of pasting a 60-min admin JWT into
IAM_SERVICE_TOKEN env.

Resolution order:
  - settings.iam_service_token (operator override) — wins, never refreshed
  - bootstrap creds (env: IAM_BOOTSTRAP_USERNAME + IAM_BOOTSTRAP_PASSWORD)
    → mint and cache
  - neither → return None; callers degrade
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx

from .config import settings

log = logging.getLogger(__name__)

_SCOPES        = ["read:reference-data", "read:mcp-servers", "publish:events"]
_SERVICE_NAME  = "context-api"
_REFRESH_BUFFER = timedelta(hours=24)
_TTL_HOURS     = 24 * 30

_cached_jwt: Optional[str] = None
_cached_exp: Optional[datetime] = None
_lock = asyncio.Lock()


def _decode_exp(jwt: str) -> Optional[datetime]:
    try:
        parts = jwt.split(".")
        if len(parts) < 2:
            return None
        # Pad base64 if needed.
        b = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(b).decode())
        exp = payload.get("exp")
        return datetime.fromtimestamp(exp, tz=timezone.utc) if isinstance(exp, (int, float)) else None
    except Exception:
        return None


def _is_fresh() -> bool:
    if _cached_jwt is None or _cached_exp is None:
        return False
    return _cached_exp - datetime.now(timezone.utc) > _REFRESH_BUFFER


async def _mint() -> Optional[str]:
    global _cached_jwt, _cached_exp
    if not settings.iam_base_url:
        return None
    username = os.environ.get("IAM_BOOTSTRAP_USERNAME")
    password = os.environ.get("IAM_BOOTSTRAP_PASSWORD")
    if not username or not password:
        log.warning("[iam-service-token] IAM_BOOTSTRAP_USERNAME/PASSWORD not set; cannot auto-mint")
        return None
    base = settings.iam_base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            login = await client.post(f"{base}/auth/local/login",
                                      json={"email": username, "password": password})
            if login.status_code >= 400:
                log.warning("[iam-service-token] bootstrap login failed (%s)", login.status_code)
                return None
            user_jwt = login.json().get("access_token")
            if not user_jwt:
                return None

            mint = await client.post(
                f"{base}/auth/service-token",
                headers={"authorization": f"Bearer {user_jwt}"},
                json={"service_name": _SERVICE_NAME, "scopes": _SCOPES, "ttl_hours": _TTL_HOURS},
            )
            if mint.status_code >= 400:
                log.warning("[iam-service-token] mint failed (%s): %s", mint.status_code, mint.text[:200])
                return None
            jwt = mint.json().get("access_token")
            if not jwt:
                return None
    except Exception as exc:
        log.warning("[iam-service-token] mint errored: %s", exc)
        return None

    _cached_jwt = jwt
    _cached_exp = _decode_exp(jwt) or (datetime.now(timezone.utc) + timedelta(hours=_TTL_HOURS))
    log.info("[iam-service-token] minted %s token; expires %s", _SERVICE_NAME, _cached_exp.isoformat())
    return jwt


async def get_iam_service_token() -> Optional[str]:
    """Return a valid IAM bearer for service-to-service calls.

    Prefers explicit settings.iam_service_token if non-empty (operator
    override). Otherwise auto-mints + caches; refreshes when <24h to expiry.
    Coalesces concurrent callers via an asyncio.Lock.
    """
    if settings.iam_service_token:
        return settings.iam_service_token
    if _is_fresh():
        return _cached_jwt
    async with _lock:
        # Double-check inside the lock — another waiter may have minted.
        if _is_fresh():
            return _cached_jwt
        return await _mint()


def invalidate_iam_service_token() -> None:
    """Force the next get_iam_service_token() to refresh."""
    global _cached_jwt, _cached_exp
    _cached_jwt = None
    _cached_exp = None
