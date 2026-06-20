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

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

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

    user_id = str(hello.get("user_id") or claims.get("user_id") or claims.get("sub") or "")
    tenant_id = str(
        hello.get("tenant_id")
        or claims.get("tenant_id")
        or claims.get("tenant")
        or claims.get("org_id")
        or ""
    )
    runtime_id = str(
        hello.get("runtime_id")
        or claims.get("runtime_id")
        or hello.get("device_id")
        or claims.get("device_id")
        or claims.get("sub")
        or ""
    )
    if not user_id or not runtime_id:
        await ws.close(code=4401, reason="missing runtime identity")
        return

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
    tags_raw = hello.get("capability_tags") or claims.get("capability_tags") or claims.get("capabilities")
    capability_tags = (
        [str(s) for s in tags_raw] if isinstance(tags_raw, list) else []
    )
    health_raw = hello.get("health")
    health = health_raw if isinstance(health_raw, dict) else {}
    shared = bool(
        hello.get("shared")
        or claims.get("shared")
        or str(hello.get("runtime_scope") or claims.get("runtime_scope") or "").lower()
        in {"tenant", "shared"}
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
        await REGISTRY.deregister(user_id, runtime_id)


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
