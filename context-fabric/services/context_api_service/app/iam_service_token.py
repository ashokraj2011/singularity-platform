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
from .env_config import bounded_float_env

log = logging.getLogger(__name__)

_SCOPES        = ["read:reference-data", "read:mcp-servers", "publish:events"]
_SERVICE_NAME  = "context-api"
_REFRESH_BUFFER = timedelta(hours=24)
_TTL_HOURS     = 24 * 30
IAM_SERVICE_TOKEN_TIMEOUT_SEC = bounded_float_env(
    "CONTEXT_FABRIC_IAM_SERVICE_TOKEN_TIMEOUT_SEC",
    default=10.0,
    min_value=1.0,
    max_value=300.0,
    logger=log,
)

_cached_jwt: Optional[str] = None
_cached_exp: Optional[datetime] = None
_lock = asyncio.Lock()


def _response_json_object(response: httpx.Response, source: str) -> Optional[dict]:
    text = response.text or ""
    if not text.strip():
        log.warning("[iam-service-token] %s returned an empty response (%s)", source, response.status_code)
        return None
    try:
        payload = json.loads(text)
    except Exception as exc:
        log.warning(
            "[iam-service-token] %s returned invalid JSON (%s): %s; body=%s",
            source,
            response.status_code,
            exc,
            text[:200],
        )
        return None
    if not isinstance(payload, dict):
        log.warning("[iam-service-token] %s returned a non-object JSON response (%s)", source, response.status_code)
        return None
    return payload


def _access_token_from_response(response: httpx.Response, source: str) -> Optional[str]:
    payload = _response_json_object(response, source)
    token = payload.get("access_token") if isinstance(payload, dict) else None
    if isinstance(token, str) and token.strip():
        return token
    log.warning("[iam-service-token] %s response did not include access_token", source)
    return None


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


def _decode_payload(jwt: str) -> Optional[dict]:
    try:
        parts = jwt.split(".")
        if len(parts) < 2:
            return None
        b = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(b).decode())
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def configured_tenant_ids_for_service_token() -> list[str]:
    return sorted({
        item.strip()
        for item in (settings.iam_service_token_tenant_ids or "").split(",")
        if item.strip()
    })


def validate_iam_service_token_tenant_scope(jwt: Optional[str]) -> bool:
    if not settings.require_tenant_id:
        return True
    required = configured_tenant_ids_for_service_token()
    if not required:
        log.warning("[iam-service-token] REQUIRE_TENANT_ID=true requires IAM_SERVICE_TOKEN_TENANT_IDS")
        return False
    payload = _decode_payload(jwt or "")
    raw_tenant_ids = payload.get("tenant_ids") if isinstance(payload, dict) else None
    actual = sorted({
        item.strip()
        for item in raw_tenant_ids
        if isinstance(item, str) and item.strip()
    }) if isinstance(raw_tenant_ids, list) else []
    if actual != required:
        log.warning("[iam-service-token] service token tenant_ids do not match IAM_SERVICE_TOKEN_TENANT_IDS")
        return False
    return True


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
        async with httpx.AsyncClient(timeout=IAM_SERVICE_TOKEN_TIMEOUT_SEC) as client:
            login = await client.post(f"{base}/auth/local/login",
                                      json={"email": username, "password": password})
            if login.status_code >= 400:
                log.warning("[iam-service-token] bootstrap login failed (%s)", login.status_code)
                return None
            user_jwt = _access_token_from_response(login, "bootstrap login")
            if not user_jwt:
                return None

            mint = await client.post(
                f"{base}/auth/service-token",
                headers={"authorization": f"Bearer {user_jwt}"},
                json={
                    "service_name": _SERVICE_NAME,
                    "scopes": _SCOPES,
                    "tenant_ids": configured_tenant_ids_for_service_token(),
                    "ttl_hours": _TTL_HOURS,
                },
            )
            if mint.status_code >= 400:
                log.warning("[iam-service-token] mint failed (%s): %s", mint.status_code, mint.text[:200])
                return None
            jwt = _access_token_from_response(mint, "service-token mint")
            if not jwt:
                return None
            if not validate_iam_service_token_tenant_scope(jwt):
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
    explicit = (settings.iam_service_token or "").strip()
    if explicit:
        exp = _decode_exp(explicit)
        if exp and exp > datetime.now(timezone.utc) + timedelta(minutes=5) and validate_iam_service_token_tenant_scope(explicit):
            return explicit
        log.warning("[iam-service-token] ignoring non-JWT or expired IAM_SERVICE_TOKEN; attempting bootstrap mint")
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
