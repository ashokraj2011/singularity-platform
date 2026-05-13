"""
M26 — WebSocket bridge for laptop-resident mcp-server instances.

   wss://platform/api/laptop-bridge/connect
       │
       ▼  Authorization: Bearer <90-day device JWT>
   1. handshake: device verifies token (HS256 via shared JWT_SECRET)
   2. laptop sends "hello" → bridge replies "auth.ack"
   3. laptop heartbeats every 30s
   4. bridge forwards /mcp/invoke envelopes from /execute
   5. laptop replies with "response" frame; bridge resolves the asyncio.Future
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

log = logging.getLogger("laptop-bridge")

router = APIRouter()

JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-change-in-prod-min-32-chars!!")
JWT_ALGORITHM = "HS256"
HEARTBEAT_SWEEP_SEC = 30


def _verify_device_token(token: str) -> dict[str, Any]:
    """Decode + validate a device JWT. Raises JWTError on failure."""
    claims = _verify_hs256_jwt(token, JWT_SECRET)
    # M26 requires kind:device. Reject other token kinds.
    if claims.get("kind") != "device":
        raise JWTError(f"expected kind=device, got {claims.get('kind')}")
    if not claims.get("sub"):
        raise JWTError("missing sub")
    if not claims.get("device_id"):
        raise JWTError("missing device_id")
    return claims


@router.websocket("/api/laptop-bridge/connect")
async def laptop_connect(ws: WebSocket) -> None:
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
        claims = _verify_device_token(token)
    except JWTError as err:
        log.warning("device token rejected: %s", err)
        await ws.close(code=4401, reason="invalid device token")
        return

    user_id   = str(claims["sub"])
    device_id = str(claims["device_id"])

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

    device_name = str(hello.get("device_name") or claims.get("device_name") or "unknown-laptop")

    conn = ActiveConnection(
        user_id=user_id,
        device_id=device_id,
        device_name=device_name,
        ws=ws,
        connected_at=time.time(),
        last_seen_at=time.time(),
    )
    await REGISTRY.register(conn)
    log.info("laptop connected user=%s device=%s name=%s", user_id, device_id, device_name)

    try:
        await ws.send_text(json.dumps({
            "type": "auth.ack",
            "user_id": user_id,
            "device_id": device_id,
            "registered_at": _now_iso(),
            "max_concurrent_invokes": 1,
        }))

        while True:
            raw = await ws.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("bad JSON frame from user=%s device=%s", user_id, device_id)
                continue
            ftype = frame.get("type")
            if ftype == "heartbeat":
                await REGISTRY.heartbeat(user_id, device_id)
            elif ftype == "response":
                await REGISTRY.deliver_response(
                    user_id=user_id, device_id=device_id,
                    request_id=str(frame.get("request_id", "")),
                    payload=frame.get("payload"),
                    error=frame.get("error"),
                )
            else:
                log.debug("unhandled frame type=%s from user=%s", ftype, user_id)

    except WebSocketDisconnect:
        log.info("laptop disconnected user=%s device=%s", user_id, device_id)
    except Exception as err:
        log.warning("laptop WS error user=%s device=%s err=%s", user_id, device_id, err)
    finally:
        await REGISTRY.deregister(user_id, device_id)


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
@router.get("/api/laptop-bridge/status")
async def status() -> dict[str, Any]:
    out: list[dict[str, Any]] = []
    # Use the internal map directly — read-only.
    for user_id, by_device in REGISTRY._by_user.items():
        for device_id, conn in by_device.items():
            out.append({
                "user_id": user_id,
                "device_id": device_id,
                "device_name": conn.device_name,
                "connected_at": conn.connected_at,
                "last_seen_at": conn.last_seen_at,
            })
    return {"connected": out, "count": len(out)}


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
