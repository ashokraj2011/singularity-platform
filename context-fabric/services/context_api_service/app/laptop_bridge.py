"""
Runtime WebSocket bridge for MCP runtime dial-in.

   wss://platform/api/runtime-bridge/connect
       │
       ▼  Authorization: Bearer <runtime/device JWT>
   1. handshake: runtime verifies token (HS256 via shared JWT_SECRET)
   2. runtime sends "hello" → bridge replies "auth.ack"
   3. runtime heartbeats every 30s
   4. bridge forwards typed frames: tool-run, model-run, code-context, invoke
   5. runtime replies with "response" frame; bridge resolves the Future

The legacy /api/laptop-bridge/connect and kind=device token shape remain
accepted during migration.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import time
from typing import Any, Optional

import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .config import settings
from .iam_service_token import get_iam_service_token, invalidate_iam_service_token
from .laptop_registry import REGISTRY, ActiveConnection


class JWTError(Exception):
    """Raised when a device JWT fails verification."""


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _verify_hs256_jwt(token: str, secret: str) -> dict[str, Any]:
    """Pure-Python HS256 JWT verify. Avoids the python-jose / cryptography
    native wheel which segfaults on some arch combinations."""
    parts = token.split(".")
    if len(parts) != 3:
        raise JWTError("malformed JWT")
    header_b64, payload_b64, sig_b64 = parts
    try:
        header = json.loads(_b64url_decode(header_b64))
    except Exception:
        raise JWTError("bad header") from None
    if header.get("alg") != "HS256":
        raise JWTError(f"unsupported alg: {header.get('alg')}")
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    try:
        actual = _b64url_decode(sig_b64)
    except Exception:
        raise JWTError("bad signature encoding") from None
    if not hmac.compare_digest(expected, actual):
        raise JWTError("signature mismatch")
    try:
        claims = json.loads(_b64url_decode(payload_b64))
    except Exception:
        raise JWTError("bad payload") from None
    # exp check (seconds since epoch)
    now = int(time.time())
    if isinstance(claims.get("exp"), (int, float)) and now > int(claims["exp"]):
        raise JWTError("token expired")
    return claims

log = logging.getLogger("runtime-bridge")

router = APIRouter()

# Dev fallback aligned with docker-compose + IAM so an IAM-signed device token
# verifies here when JWT_SECRET is unset. ALWAYS override in any real deployment.
JWT_SECRET = os.environ.get("JWT_SECRET", "changeme_dev_only_min_32_chars_long!!")
JWT_ALGORITHM = "HS256"
HEARTBEAT_SWEEP_SEC = 30

# Finding #7 — device-revocation enforcement. A revoked device JWT must stop working
# without waiting for its (up-to-365-day) natural expiry, so the bridge asks IAM whether
# the device row is revoked: once at connect, then periodically for live connections.
REVOCATION_RECHECK_SEC = int(os.environ.get("RUNTIME_BRIDGE_REVOCATION_RECHECK_SEC", "300"))
# When IAM can't be reached, fail OPEN by default so a transient IAM blip doesn't take
# down all runtime dial-in; the periodic recheck still catches the device once IAM
# recovers. Set RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN=false to fail closed (reject when
# revocation can't be confirmed at connect).
REVOCATION_FAIL_OPEN = os.environ.get("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", "true").lower() not in ("0", "false", "no")


def _iam_api_base() -> Optional[str]:
    raw = (getattr(settings, "iam_base_url", "") or "").rstrip("/")
    if not raw:
        return None
    return raw if raw.endswith("/api/v1") else f"{raw}/api/v1"


async def _device_revoked(user_id: str, device_id: str) -> Optional[bool]:
    """Ask IAM whether (user_id, device_id) is revoked. Returns True/False, or None when
    the check can't be performed (IAM not configured/unreachable) so callers can apply
    their fail-open/closed policy."""
    base = _iam_api_base()
    if not base or not device_id:
        return None
    token = await get_iam_service_token()
    if not token:
        return None
    url = f"{base}/internal/devices/status"
    params = {"user_id": user_id, "device_id": device_id}
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url, params=params, headers=headers)
            if resp.status_code == 401:
                invalidate_iam_service_token()
                return None
            resp.raise_for_status()
            data = resp.json()
        return bool(data.get("revoked"))
    except Exception as err:  # network / parse failure — let the caller decide policy
        log.warning("device revocation check failed user=%s device=%s err=%s", user_id, device_id, err)
        return None


def _verify_runtime_token(token: str) -> dict[str, Any]:
    """Decode + validate a runtime/device JWT. Raises JWTError on failure."""
    claims = _verify_hs256_jwt(token, JWT_SECRET)
    if claims.get("kind") not in {"runtime", "device"}:
        raise JWTError(f"expected kind=runtime|device, got {claims.get('kind')}")
    if not claims.get("sub"):
        raise JWTError("missing sub")
    if claims.get("kind") == "device" and not claims.get("device_id"):
        raise JWTError("missing device_id")
    return claims


@router.websocket("/api/runtime-bridge/connect")
@router.websocket("/api/laptop-bridge/connect")
async def runtime_connect(ws: WebSocket) -> None:
    # Extract token from Authorization or Sec-WebSocket-Protocol subprotocol.
    auth = ws.headers.get("authorization", "")
    token: Optional[str] = None
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
    if not token:
        # ws subprotocol fallback used by browsers: "bearer.<token>"
        sub = ws.headers.get("sec-websocket-protocol", "")
        if sub.startswith("bearer."):
            token = sub[7:].strip()
    if not token:
        await ws.close(code=4401, reason="missing bearer token")
        return

    try:
        claims = _verify_runtime_token(token)
    except JWTError as err:
        log.warning("runtime token rejected: %s", err)
        await ws.close(code=4401, reason="invalid runtime token")
        return

    # Finding #7 — reject a revoked device before accepting the socket. Uses the token's
    # own identity (sub + device_id), not the client-supplied hello.
    device_claim_id = str(claims.get("device_id") or "")
    claim_user_id = str(claims.get("user_id") or claims.get("sub") or "")
    if device_claim_id:
        revoked = await _device_revoked(claim_user_id, device_claim_id)
        if revoked is True:
            log.warning("rejecting revoked device user=%s device=%s", claim_user_id, device_claim_id)
            await ws.close(code=4403, reason="device revoked")
            return
        if revoked is None and not REVOCATION_FAIL_OPEN:
            log.warning("revocation unconfirmed; failing closed user=%s device=%s", claim_user_id, device_claim_id)
            await ws.close(code=4403, reason="device revocation check unavailable")
            return

    await ws.accept()

    # Wait for hello.
    try:
        hello_raw = await asyncio.wait_for(ws.receive_text(), timeout=10)
    except asyncio.TimeoutError:
        await ws.close(code=4400, reason="hello timeout")
        return
    try:
        hello = json.loads(hello_raw)
    except json.JSONDecodeError:
        await ws.close(code=4400, reason="bad hello JSON")
        return
    if hello.get("type") != "hello":
        await ws.close(code=4400, reason=f"expected hello, got {hello.get('type')}")
        return

    # SECURITY: identity + routing fields come from the VERIFIED JWT claims ONLY.
    # The client-supplied hello frame is advisory metadata (device_name,
    # runtime_type, supported_frame_types, health) and must NOT be able to set
    # user_id / tenant_id / runtime_id / shared / capability_tags — otherwise a
    # holder of any valid runtime token could register as another user, tenant,
    # or shared runtime and have tool/model/code work misrouted to them.
    user_id = str(claims.get("user_id") or claims.get("sub") or "")
    tenant_id = str(
        claims.get("tenant_id")
        or claims.get("tenant")
        or claims.get("org_id")
        or ""
    )
    runtime_id = str(
        claims.get("runtime_id")
        or claims.get("device_id")
        or claims.get("sub")
        or ""
    )
    if not user_id or not runtime_id:
        await ws.close(code=4401, reason="missing runtime identity")
        return
    # Log (never trust) hello fields that conflict with the verified identity.
    for _field, _claimed in (("user_id", user_id), ("tenant_id", tenant_id), ("runtime_id", runtime_id)):
        _h = hello.get(_field) if _field != "runtime_id" else (hello.get("runtime_id") or hello.get("device_id"))
        if _h is not None and str(_h) != _claimed:
            log.warning("ignoring hello.%s=%r conflicting with verified claim %r", _field, _h, _claimed)

    runtime_type = str(hello.get("runtime_type") or claims.get("runtime_type") or "mcp")
    device_name = str(hello.get("device_name") or claims.get("device_name") or runtime_id)
    sft_raw = hello.get("supported_frame_types")
    supported_frame_types = (
        [str(s) for s in sft_raw] if isinstance(sft_raw, list) and sft_raw else ["invoke"]
    )
    allowed_raw = claims.get("allowed_frame_types")
    if isinstance(allowed_raw, list) and allowed_raw:
        allowed = {str(s) for s in allowed_raw}
        supported_frame_types = [s for s in supported_frame_types if s in allowed]
    if not supported_frame_types:
        await ws.close(code=4401, reason="no allowed frame types")
        return
    # capability_tags + shared are routing-relevant → verified claims ONLY.
    tags_raw = claims.get("capability_tags") or claims.get("capabilities")
    capability_tags = (
        [str(s) for s in tags_raw] if isinstance(tags_raw, list) else []
    )
    health_raw = hello.get("health")
    health = health_raw if isinstance(health_raw, dict) else {}
    shared = bool(
        claims.get("shared")
        or str(claims.get("runtime_scope") or "").lower() in {"tenant", "shared"}
    )

    conn = ActiveConnection(
        user_id=user_id,
        device_id=runtime_id,
        device_name=device_name,
        ws=ws,
        connected_at=time.time(),
        last_seen_at=time.time(),
        supported_frame_types=supported_frame_types,
        runtime_id=runtime_id,
        runtime_type=runtime_type,
        tenant_id=tenant_id,
        shared=shared,
        capability_tags=capability_tags,
        health=health,
    )
    await REGISTRY.register(conn)
    log.info(
        "runtime connected tenant=%s user=%s runtime=%s type=%s name=%s",
        tenant_id, user_id, runtime_id, runtime_type, device_name,
    )

    try:
        await ws.send_text(json.dumps({
            "type": "auth.ack",
            "user_id": user_id,
            "tenant_id": tenant_id,
            "runtime_id": runtime_id,
            "runtime_type": runtime_type,
            "device_id": runtime_id,
            "registered_at": _now_iso(),
            "max_concurrent_invokes": 1,
            "accepted_frame_types": supported_frame_types,
        }))

        last_rev_check = time.monotonic()
        while True:
            raw = await ws.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("bad JSON frame from user=%s runtime=%s", user_id, runtime_id)
                continue
            ftype = frame.get("type")
            if ftype == "heartbeat":
                await REGISTRY.heartbeat(user_id, runtime_id)
                # Finding #7 — re-check revocation for this live connection, throttled to
                # REVOCATION_RECHECK_SEC. Only a confirmed revocation disconnects; an
                # unreachable IAM (None) leaves the session up until it can be confirmed.
                if device_claim_id and (time.monotonic() - last_rev_check) >= REVOCATION_RECHECK_SEC:
                    last_rev_check = time.monotonic()
                    if await _device_revoked(claim_user_id, device_claim_id) is True:
                        log.warning("disconnecting revoked device mid-session user=%s device=%s", claim_user_id, device_claim_id)
                        await ws.close(code=4403, reason="device revoked")
                        break
            elif ftype == "response":
                await REGISTRY.deliver_response(
                    user_id=user_id, device_id=runtime_id,
                    request_id=str(frame.get("request_id", "")),
                    payload=frame.get("payload"),
                    error=frame.get("error"),
                )
            else:
                log.debug("unhandled frame type=%s from user=%s", ftype, user_id)

    except WebSocketDisconnect:
        log.info("runtime disconnected user=%s runtime=%s", user_id, runtime_id)
    except Exception as err:
        log.warning("runtime WS error user=%s runtime=%s err=%s", user_id, runtime_id, err)
    finally:
        await REGISTRY.deregister(user_id, runtime_id, conn)


# ── Periodic stale-connection sweep (R3) ───────────────────────────────────
_SWEEP_TASK: Optional[asyncio.Task] = None


async def _sweep_loop() -> None:
    try:
        while True:
            await asyncio.sleep(HEARTBEAT_SWEEP_SEC)
            try:
                await REGISTRY.reap_stale()
            except Exception as err:
                log.warning("reap_stale failed: %s", err)
    except asyncio.CancelledError:
        return


def start_sweep_task() -> None:
    global _SWEEP_TASK
    if _SWEEP_TASK is None or _SWEEP_TASK.done():
        loop = asyncio.get_event_loop()
        _SWEEP_TASK = loop.create_task(_sweep_loop())


def stop_sweep_task() -> None:
    global _SWEEP_TASK
    if _SWEEP_TASK is not None and not _SWEEP_TASK.done():
        _SWEEP_TASK.cancel()
        _SWEEP_TASK = None


# ── Status endpoint (handy for the SPA + smoke tests) ──────────────────────
@router.get("/api/runtime-bridge/status")
async def runtime_status() -> dict[str, Any]:
    return await REGISTRY.status_snapshot()


@router.get("/api/laptop-bridge/status")
async def status() -> dict[str, Any]:
    return await REGISTRY.status_snapshot()


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
