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
from urllib.parse import quote
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from .config import settings, is_production_class_env
from .iam_service_token import get_iam_service_token, invalidate_iam_service_token
from .laptop_registry import (
    REGISTRY,
    ActiveConnection,
    LaptopInvokeError,
    LaptopInvokeTimeout,
    LaptopNotConnected,
    LaptopSendFailed,
    MAX_PAYLOAD_BYTES,
)
from .response_json import response_json_object


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
    # Runtime/device tokens are long-lived but never unbounded. JWT "exp" is a
    # NumericDate; reject missing or malformed expiries instead of treating them
    # as non-expiring bridge credentials.
    now = int(time.time())
    exp = claims.get("exp")
    if type(exp) not in (int, float):
        raise JWTError("missing or invalid exp")
    if now > int(exp):
        raise JWTError("token expired")
    return claims

log = logging.getLogger("runtime-bridge")

router = APIRouter()

# Dev fallback aligned with docker-compose + IAM so an IAM-signed device token
# verifies here when JWT_SECRET is unset. ALWAYS override in any real deployment.
JWT_SECRET = os.environ.get("JWT_SECRET", "changeme_dev_only_min_32_chars_long!!")
JWT_ALGORITHM = "HS256"
HEARTBEAT_SWEEP_SEC = 30
_TRUTHY = {"1", "true", "yes", "on"}
_KNOWN_RUNTIME_FRAME_TYPES = {
    "invoke",
    "tool-run",
    "model-run",
    "code-context",
    "source-tree",
    "source-file",
    "work-finish-branch",
    "worktree-write-file",
}
_MAX_RUNTIME_CAPABILITY_TAGS = 32
_MAX_RUNTIME_CAPABILITY_TAG_LEN = 96
_MAX_RUNTIME_USER_ID_LEN = 128
_MAX_RUNTIME_ID_LEN = 128
_MAX_RUNTIME_TENANT_ID_LEN = 128
_MAX_RUNTIME_TYPE_LEN = 64
_MAX_RUNTIME_DEVICE_NAME_LEN = 200
_MAX_RUNTIME_REQUEST_ID_LEN = 128

# Finding #7 — device-revocation enforcement. A revoked device JWT must stop working
# without waiting for its (up-to-365-day) natural expiry, so the bridge asks IAM whether
# the device row is revoked: once at connect, then periodically for live connections.
REVOCATION_RECHECK_SEC = int(os.environ.get("RUNTIME_BRIDGE_REVOCATION_RECHECK_SEC", "300"))
# SECURITY: when IAM can't be reached at connect, fail CLOSED by default in
# production-class envs (a revoked device must not slip in during an IAM blip),
# and fail OPEN only in dev so a local IAM blip doesn't take down dial-in. The
# periodic recheck still catches the device once IAM recovers. Override
# explicitly with RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN={true,false}.
_rev_fail_open_default = "false" if is_production_class_env() else "true"
REVOCATION_FAIL_OPEN = os.environ.get("RUNTIME_BRIDGE_REVOCATION_FAIL_OPEN", _rev_fail_open_default).lower() not in ("0", "false", "no")


def _runtime_bridge_allow_unauthenticated_http() -> bool:
    """Explicit local-only escape hatch for bridge HTTP dispatch/debug endpoints.

    Runtime WebSocket connect always authenticates with runtime JWTs. These HTTP
    endpoints are the control-plane side of that bridge and can dispatch source,
    tool, branch, or file-write frames to a connected runtime, so they stay
    service-token protected even when /execute is relaxed for local demos.
    """
    if is_production_class_env():
        return False
    return os.environ.get("RUNTIME_BRIDGE_ALLOW_UNAUTHENTICATED_HTTP", "").lower() in _TRUTHY


def _runtime_http_fallback_enabled() -> bool:
    return os.environ.get("RUNTIME_HTTP_FALLBACK_ENABLED", "false").strip().lower() in _TRUTHY


def _raise_runtime_http_fallback_disabled(operation: str) -> None:
    raise HTTPException(
        status_code=503,
        detail=(
            f"RUNTIME_NOT_CONNECTED: no connected MCP runtime is available for {operation}; "
            "direct MCP HTTP fallback is disabled. Start a Runtime Bridge MCP runtime "
            "or set RUNTIME_HTTP_FALLBACK_ENABLED=true for explicit local/debug fallback."
        ),
    )


def _runtime_bridge_service_tokens() -> list[str]:
    raw = [
        getattr(settings, "iam_service_token", "") or "",
        os.environ.get("CONTEXT_FABRIC_SERVICE_TOKEN", "") or "",
    ]
    tokens: list[str] = []
    for token in raw:
        cleaned = token.strip()
        if cleaned and cleaned not in tokens:
            tokens.append(cleaned)
    return tokens


def check_runtime_bridge_service_token(provided: Optional[str]) -> None:
    if _runtime_bridge_allow_unauthenticated_http():
        return
    expected = _runtime_bridge_service_tokens()
    if not expected:
        raise HTTPException(status_code=503, detail="runtime bridge service token is not configured")
    if not provided:
        raise HTTPException(status_code=401, detail="missing runtime bridge service token")
    supplied = provided.strip()
    if not any(hmac.compare_digest(supplied, token) for token in expected):
        raise HTTPException(status_code=401, detail="invalid runtime bridge service token")


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
            data = response_json_object(resp, "IAM device status")
        return bool(data.get("revoked"))
    except Exception as err:  # network / parse failure — let the caller decide policy
        log.warning("device revocation check failed user=%s device=%s err=%s", user_id, device_id, err)
        return None


def _claim_str(claims: dict[str, Any], key: str) -> str:
    value = claims.get(key)
    if value is None:
        return ""
    return str(value).strip()


def _claim_bool(claims: dict[str, Any], key: str) -> bool:
    value = claims.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def _reject_oversized_claim(claims: dict[str, Any], key: str, max_len: int) -> None:
    value = _claim_str(claims, key)
    if value and len(value) > max_len:
        raise JWTError(f"{key} too long")


def _runtime_claims_shared(claims: dict[str, Any]) -> bool:
    return _claim_bool(claims, "shared") or _claim_str(claims, "runtime_scope").lower() in {
        "tenant",
        "shared",
    }


def _runtime_frame_list(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    frames: list[str] = []
    seen: set[str] = set()
    for item in raw:
        frame = str(item).strip()
        if not frame or frame not in _KNOWN_RUNTIME_FRAME_TYPES or frame in seen:
            continue
        seen.add(frame)
        frames.append(frame)
    return frames


def _runtime_capability_tag_list(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    tags: list[str] = []
    seen: set[str] = set()
    for item in raw:
        value = str(item).strip()
        if not value:
            continue
        value = value[:_MAX_RUNTIME_CAPABILITY_TAG_LEN]
        if value in seen:
            continue
        seen.add(value)
        tags.append(value)
        if len(tags) >= _MAX_RUNTIME_CAPABILITY_TAGS:
            break
    return tags


def _verify_runtime_token(token: str) -> dict[str, Any]:
    """Decode + validate a runtime/device JWT. Raises JWTError on failure."""
    claims = _verify_hs256_jwt(token, JWT_SECRET)
    kind = claims.get("kind")
    if kind not in {"runtime", "device"}:
        raise JWTError(f"expected kind=runtime|device, got {kind}")
    for key in ("sub", "user_id"):
        _reject_oversized_claim(claims, key, _MAX_RUNTIME_USER_ID_LEN)
    for key in ("device_id", "runtime_id"):
        _reject_oversized_claim(claims, key, _MAX_RUNTIME_ID_LEN)
    for key in ("tenant_id", "tenant", "org_id"):
        _reject_oversized_claim(claims, key, _MAX_RUNTIME_TENANT_ID_LEN)
    _reject_oversized_claim(claims, "runtime_type", _MAX_RUNTIME_TYPE_LEN)
    _reject_oversized_claim(claims, "device_name", _MAX_RUNTIME_DEVICE_NAME_LEN)
    if not _claim_str(claims, "sub"):
        raise JWTError("missing sub")
    if kind == "device" and not _claim_str(claims, "device_id"):
        raise JWTError("missing device_id")
    if kind == "runtime" and not (_claim_str(claims, "runtime_id") or _claim_str(claims, "device_id")):
        raise JWTError("missing runtime_id")
    if kind == "runtime" and not _runtime_frame_list(claims.get("allowed_frame_types")):
        raise JWTError("missing allowed_frame_types")
    return claims


def _first_claim_str(claims: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = _claim_str(claims, key)
        if value:
            return value
    return ""


def _first_hello_str(hello: dict[str, Any], *keys: str, max_len: int | None = None) -> str:
    for key in keys:
        value = hello.get(key)
        if value is not None and str(value).strip():
            cleaned = str(value).strip()
            return cleaned[:max_len] if max_len is not None else cleaned
    return ""


def _token_authoritative_runtime_metadata(
    claims: dict[str, Any],
    hello: dict[str, Any],
) -> dict[str, str]:
    """Resolve runtime registration metadata.

    Routing identity and operator-visible runtime identity should come from the
    verified JWT when claims exist. The hello frame is a compatibility fallback
    for older device tokens that did not carry runtime_type/device_name, not a
    way for a runtime to impersonate another tenant/user/runtime shape.
    """
    user_id = _first_claim_str(claims, "user_id", "sub")
    tenant_id = _first_claim_str(claims, "tenant_id", "tenant", "org_id")
    runtime_id = _first_claim_str(claims, "runtime_id", "device_id", "sub")
    runtime_type = (
        _first_claim_str(claims, "runtime_type")
        or _first_hello_str(hello, "runtime_type", max_len=_MAX_RUNTIME_TYPE_LEN)
        or "mcp"
    )
    device_name = (
        _first_claim_str(claims, "device_name")
        or _first_hello_str(hello, "device_name", max_len=_MAX_RUNTIME_DEVICE_NAME_LEN)
        or runtime_id
    )
    return {
        "user_id": user_id,
        "tenant_id": tenant_id,
        "runtime_id": runtime_id,
        "runtime_type": runtime_type,
        "device_name": device_name,
    }


def _runtime_revocation_identity(claims: dict[str, Any]) -> tuple[str, str]:
    """Return the IAM device-status lookup identity for a bridge token.

    IAM stores runtime tokens on the user-device surface. Modern IAM tokens carry
    both device_id and runtime_id, but hand-minted/runtime-only tokens may carry
    runtime_id only. Treat runtime_id as the revocable device identity fallback
    so those tokens cannot bypass revocation checks.
    """
    return (
        _first_claim_str(claims, "user_id", "sub"),
        _first_claim_str(claims, "device_id", "runtime_id"),
    )


def _runtime_frame_size(raw: str) -> int:
    return len(raw.encode("utf-8"))


def _runtime_frame_too_large(raw: str) -> bool:
    return _runtime_frame_size(raw) > MAX_PAYLOAD_BYTES


def _runtime_response_request_id(frame: dict[str, Any]) -> str | None:
    value = frame.get("request_id")
    if not isinstance(value, str):
        return None
    if not value.strip() or len(value) > _MAX_RUNTIME_REQUEST_ID_LEN:
        return None
    return value


def _runtime_json_object(raw: str) -> tuple[dict[str, Any] | None, str | None]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None, "bad-json"
    if not isinstance(parsed, dict):
        return None, "not-object"
    return parsed, None


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

    # Finding #7 — reject a revoked runtime/device before accepting the socket.
    # Uses the token's own identity, not the client-supplied hello. Runtime-only
    # tokens may carry runtime_id without device_id, so runtime_id is the
    # revocation identity fallback.
    claim_user_id, device_claim_id = _runtime_revocation_identity(claims)
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
    if _runtime_frame_too_large(hello_raw):
        await ws.close(code=1009, reason="runtime hello too large")
        return
    hello, hello_err = _runtime_json_object(hello_raw)
    if hello is None:
        reason = "bad hello JSON" if hello_err == "bad-json" else "bad hello frame"
        await ws.close(code=4400, reason=reason)
        return
    if hello.get("type") != "hello":
        await ws.close(code=4400, reason=f"expected hello, got {hello.get('type')}")
        return

    # SECURITY: identity + routing fields come from the VERIFIED JWT claims ONLY.
    # The client-supplied hello frame is advisory metadata (supported_frame_types,
    # health) and a compatibility fallback for legacy display fields. It must NOT
    # be able to set user_id / tenant_id / runtime_id / runtime_type / device_name
    # / shared / capability_tags — otherwise a holder of any valid runtime token
    # could register as another runtime and have tool/model/code work misrouted
    # or misrepresented in Operations.
    metadata = _token_authoritative_runtime_metadata(claims, hello)
    user_id = metadata["user_id"]
    tenant_id = metadata["tenant_id"]
    runtime_id = metadata["runtime_id"]
    runtime_type = metadata["runtime_type"]
    device_name = metadata["device_name"]
    if not user_id or not runtime_id:
        await ws.close(code=4401, reason="missing runtime identity")
        return
    # Log (never trust) hello fields that conflict with the verified identity.
    for _field, _claimed in (
        ("user_id", user_id),
        ("tenant_id", tenant_id),
        ("runtime_id", runtime_id),
        ("runtime_type", runtime_type),
        ("device_name", device_name),
    ):
        _h = hello.get(_field) if _field != "runtime_id" else (hello.get("runtime_id") or hello.get("device_id"))
        if _h is not None and str(_h) != _claimed:
            log.warning("ignoring hello.%s=%r conflicting with verified claim %r", _field, _h, _claimed)

    supported_frame_types = _runtime_frame_list(hello.get("supported_frame_types")) or ["invoke"]
    allowed_frame_types = _runtime_frame_list(claims.get("allowed_frame_types"))
    if allowed_frame_types:
        allowed = set(allowed_frame_types)
        supported_frame_types = [s for s in supported_frame_types if s in allowed]
    if not supported_frame_types:
        await ws.close(code=4401, reason="no allowed frame types")
        return
    # capability_tags + shared are routing-relevant → verified claims ONLY.
    capability_tags = _runtime_capability_tag_list(
        claims.get("capability_tags") or claims.get("capabilities")
    )
    health_raw = hello.get("health")
    health = health_raw if isinstance(health_raw, dict) else {}
    shared = _runtime_claims_shared(claims)

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
            raw_size = _runtime_frame_size(raw)
            if raw_size > MAX_PAYLOAD_BYTES:
                log.warning(
                    "closing oversized runtime frame user=%s runtime=%s bytes=%s",
                    user_id,
                    runtime_id,
                    raw_size,
                )
                await ws.close(code=1009, reason="runtime frame too large")
                break
            frame, frame_err = _runtime_json_object(raw)
            if frame is None:
                if frame_err == "bad-json":
                    log.warning("bad JSON frame from user=%s runtime=%s", user_id, runtime_id)
                else:
                    log.warning("non-object frame from user=%s runtime=%s", user_id, runtime_id)
                continue
            ftype = frame.get("type")
            if ftype == "heartbeat":
                health_raw = frame.get("health")
                await REGISTRY.heartbeat(user_id, runtime_id, health_raw if isinstance(health_raw, dict) else None)
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
                request_id = _runtime_response_request_id(frame)
                if request_id is None:
                    log.warning(
                        "dropping runtime response with invalid request_id user=%s runtime=%s",
                        user_id,
                        runtime_id,
                    )
                    continue
                await REGISTRY.deliver_response(
                    user_id=user_id, device_id=runtime_id,
                    request_id=request_id,
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
async def runtime_status(
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
) -> dict[str, Any]:
    check_runtime_bridge_service_token(x_service_token)
    return await REGISTRY.status_snapshot()


@router.get("/api/laptop-bridge/status")
async def status(
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
) -> dict[str, Any]:
    check_runtime_bridge_service_token(x_service_token)
    return await REGISTRY.status_snapshot()


class _RuntimeDiagnosticsReq(BaseModel):
    user_id: Optional[str] = None
    tenant_id: Optional[str] = None
    frame_type: Optional[str] = None
    capability_tags: list[str] = []


@router.get("/api/runtime-bridge/diagnostics")
async def runtime_diagnostics_get(
    user_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
    frame_type: Optional[str] = None,
    capability_tags: list[str] = Query(default=[]),
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
) -> dict[str, Any]:
    check_runtime_bridge_service_token(x_service_token)
    return await REGISTRY.diagnostics(
        user_id=user_id,
        tenant_id=tenant_id,
        frame_type=frame_type,
        capability_tags=capability_tags,
    )


@router.post("/api/runtime-bridge/diagnostics")
async def runtime_diagnostics_post(
    req: _RuntimeDiagnosticsReq,
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
) -> dict[str, Any]:
    check_runtime_bridge_service_token(x_service_token)
    return await REGISTRY.diagnostics(
        user_id=req.user_id,
        tenant_id=req.tenant_id,
        frame_type=req.frame_type,
        capability_tags=req.capability_tags,
    )


# ── Repo source discovery over the bridge ──────────────────────────────────
# Lets a cloud control-plane service (agent-runtime capability bootstrap) read a
# repo's tree / files through the requesting USER's laptop runtime, instead of
# needing its own GitHub egress or a reachable mcp HTTP endpoint. The laptop runs
# the fetch with its LOCAL GITHUB_TOKEN; CF only relays. Routing is by user_id
# (token-authoritative on the bridge side) — the same model as code-context.
class _SourceTreeReq(BaseModel):
    user_id: str
    tenant_id: Optional[str] = None
    repoUrl: str
    branch: str = "main"


class _SourceFileReq(BaseModel):
    user_id: str
    tenant_id: Optional[str] = None
    repoUrl: str
    branch: str = "main"
    path: str


async def _dispatch_source(
    *, op: str, user_id: str, tenant_id: Optional[str], request_body: dict[str, Any]
) -> dict[str, Any]:
    try:
        return await REGISTRY.dispatch_source_via_laptop(
            user_id=user_id,
            tenant_id=tenant_id,
            capability_tags=["mcp"],
            op=op,
            request_body=request_body,
        )
    except LaptopNotConnected as err:
        # No laptop advertising the source frame is online — the caller should
        # fall back to its static MCP_SERVER_URL HTTP path (co-located mcp).
        raise HTTPException(status_code=503, detail=f"no runtime for source-{op}: {err}") from err
    except LaptopInvokeTimeout as err:
        raise HTTPException(status_code=504, detail=str(err)) from err
    except (LaptopSendFailed, LaptopInvokeError) as err:
        raise HTTPException(status_code=502, detail=str(err)) from err


@router.post("/api/runtime-bridge/source/tree")
async def runtime_source_tree(
    req: _SourceTreeReq,
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
) -> dict[str, Any]:
    check_runtime_bridge_service_token(x_service_token)
    return await _dispatch_source(
        op="tree",
        user_id=req.user_id,
        tenant_id=req.tenant_id,
        request_body={"repoUrl": req.repoUrl, "branch": req.branch},
    )


@router.post("/api/runtime-bridge/source/file")
async def runtime_source_file(
    req: _SourceFileReq,
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
) -> dict[str, Any]:
    check_runtime_bridge_service_token(x_service_token)
    return await _dispatch_source(
        op="file",
        user_id=req.user_id,
        tenant_id=req.tenant_id,
        request_body={"repoUrl": req.repoUrl, "branch": req.branch, "path": req.path},
    )


# ── Generic tool-run dispatch over the bridge ──────────────────────────────
# Lets Workgraph executors (e.g. RUN_PYTHON) dispatch a single tool through CF
# instead of POSTing mcp-server directly, so a laptop/remote MCP that only dials
# in still runs the tool. Reuses governed.dispatch.dispatch_tool, which prefers
# the requesting user's bridge (laptop_user_id) and falls back to mcp HTTP
# transparently when no bridge is connected.
class _ToolRunReq(BaseModel):
    tool_name: str
    args: dict[str, Any] = {}
    run_context: Optional[dict[str, Any]] = None
    workspace_id: Optional[str] = None
    work_item_id: Optional[str] = None
    grant: Optional[dict[str, Any]] = None
    laptop_user_id: Optional[str] = None


@router.post("/api/runtime-bridge/tool-run")
async def runtime_tool_run(
    req: _ToolRunReq,
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
) -> dict[str, Any]:
    from .governed.dispatch import dispatch_tool, ToolDispatchError

    check_runtime_bridge_service_token(x_service_token)
    rc = req.run_context or {}
    laptop_user_id = req.laptop_user_id or rc.get("user_id") or rc.get("userId")
    try:
        result = await dispatch_tool(
            req.tool_name,
            req.args,
            workspace_id=req.workspace_id,
            work_item_id=req.work_item_id,
            run_context=req.run_context,
            laptop_user_id=laptop_user_id,
            grant=req.grant,
        )
    except ToolDispatchError as err:
        raise HTTPException(status_code=502, detail=f"tool-run dispatch failed: {err}") from err
    return {
        "result": result.result,
        "tool_success": result.tool_success,
        "tool_error": result.tool_error,
        "tool_invocation_id": result.tool_invocation_id,
        "duration_ms": result.duration_ms,
        "served_by": result.served_by,
    }


# ── Work-branch finalize dispatch over the bridge ──────────────────────────
# Routes GitPushExecutor's finish-branch through CF: prefer the requesting user's
# dialed-in runtime (it pushes with its LOCAL git creds). Direct HTTP to a
# co-located/shared mcp-server is debug compatibility only and requires
# RUNTIME_HTTP_FALLBACK_ENABLED=true, matching governed tool/model dispatch.
class _WorkFinishReq(BaseModel):
    user_id: Optional[str] = None
    tenant_id: Optional[str] = None
    message: Optional[str] = None
    remote: str = "origin"
    push: bool = True
    expectedCommitSha: Optional[str] = None
    patch: Optional[str] = None
    tool_grant: Optional[dict[str, Any]] = None
    # P0 #2 — brokered, short-lived, repo-scoped git credential minted by IAM and
    # bundled with the tool-grant. Forwarded to the shared/co-located mcp-server
    # only (a dialed-in personal laptop uses its own local creds — Decision #3).
    gitCredential: Optional[dict[str, Any]] = None
    runContext: dict[str, Any] = {}


async def _http_finish_branch(payload: dict[str, Any]) -> dict[str, Any]:
    mcp_url = os.environ.get("MCP_SERVER_URL", "http://mcp-server:7100").rstrip("/")
    bearer = os.environ.get("MCP_BEARER_TOKEN", "")
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(
                f"{mcp_url}/mcp/work/finish-branch",
                headers={"content-type": "application/json", "authorization": f"Bearer {bearer}"},
                json=payload,
            )
    except httpx.HTTPError as err:
        raise HTTPException(status_code=502, detail=f"mcp /work/finish-branch unreachable: {err}") from err
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text[:300])
    data = response_json_object(resp, "MCP finish-branch fallback")
    # mcp returns {success, data:{tool_invocation, output}}; the laptop frame
    # returns {tool_invocation, output}. Normalize to the latter.
    return data.get("data", data) if isinstance(data, dict) else data


@router.post("/api/runtime-bridge/work/finish-branch")
async def runtime_work_finish_branch(
    req: _WorkFinishReq,
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
) -> dict[str, Any]:
    check_runtime_bridge_service_token(x_service_token)
    payload: dict[str, Any] = {
        "message": req.message,
        "remote": req.remote,
        "push": req.push,
        "expectedCommitSha": req.expectedCommitSha,
        "patch": req.patch,
        "tool_grant": req.tool_grant,
        "runContext": req.runContext,
    }
    rc = req.runContext or {}
    user_id = req.user_id or rc.get("user_id") or rc.get("userId")
    if user_id:
        try:
            # P0 #2 — forward the brokered credential to the chosen runtime ONLY if
            # it is SHARED (gated inside dispatch_work_finish_via_laptop): a shared
            # runtime must push as the right user, while a personal laptop keeps its
            # own local creds and is never handed a minted token (Decision #3).
            return await REGISTRY.dispatch_work_finish_via_laptop(
                user_id=user_id,
                tenant_id=req.tenant_id,
                capability_tags=["mcp"],
                request_body=payload,
                git_credential=req.gitCredential,
            )
        except LaptopNotConnected:
            pass  # fall through to the co-located/shared mcp HTTP path
        except LaptopInvokeTimeout as err:
            raise HTTPException(status_code=504, detail=str(err)) from err
        except (LaptopSendFailed, LaptopInvokeError) as err:
            raise HTTPException(status_code=502, detail=str(err)) from err
    if not _runtime_http_fallback_enabled():
        _raise_runtime_http_fallback_disabled("finish-branch")
    # P0 #2 — co-located/shared mcp-server (explicit HTTP fallback, never a
    # personal laptop): attach the brokered, short-lived, repo-scoped git
    # credential (when CF minted one) so the push authenticates as the requesting
    # user instead of a process-global static token.
    if req.gitCredential:
        payload = {**payload, "gitCredential": req.gitCredential}
    return await _http_finish_branch(payload)


# ── Worktree file write dispatch over the bridge ───────────────────────────
# Routes evidence materialization's worktree writes through CF: prefer the user's
# dialed-in runtime (writes into its LOCAL worktree). Direct HTTP fallback is
# debug compatibility only and requires RUNTIME_HTTP_FALLBACK_ENABLED=true.
class _WorktreeWriteReq(BaseModel):
    user_id: Optional[str] = None
    tenant_id: Optional[str] = None
    workItemCode: str
    path: str
    content: str
    message: Optional[str] = None
    expectedSha: Optional[str] = None
    authorEmail: Optional[str] = None
    authorName: Optional[str] = None


async def _http_worktree_write(work_item_code: str, rel_path: str, body: dict[str, Any]) -> dict[str, Any]:
    mcp_url = os.environ.get("MCP_SERVER_URL", "http://mcp-server:7100").rstrip("/")
    bearer = os.environ.get("MCP_BEARER_TOKEN", "")
    url = f"{mcp_url}/mcp/worktree/{quote(work_item_code, safe='')}/file"
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.put(
                url,
                params={"path": rel_path},
                headers={"content-type": "application/json", "authorization": f"Bearer {bearer}"},
                json=body,
            )
    except httpx.HTTPError as err:
        raise HTTPException(status_code=502, detail=f"mcp worktree write unreachable: {err}") from err
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text[:300])
    data = response_json_object(resp, "MCP worktree write fallback")
    return data.get("data", data) if isinstance(data, dict) else data


@router.post("/api/runtime-bridge/worktree/file")
async def runtime_worktree_write_file(
    req: _WorktreeWriteReq,
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
) -> dict[str, Any]:
    check_runtime_bridge_service_token(x_service_token)
    body_fields: dict[str, Any] = {
        "content": req.content,
        "message": req.message,
        "expectedSha": req.expectedSha,
        "authorEmail": req.authorEmail,
        "authorName": req.authorName,
    }
    if req.user_id:
        try:
            return await REGISTRY.dispatch_worktree_write_via_laptop(
                user_id=req.user_id,
                tenant_id=req.tenant_id,
                capability_tags=["mcp"],
                request_body={"workItemCode": req.workItemCode, "path": req.path, **body_fields},
            )
        except LaptopNotConnected:
            pass  # fall through to the co-located/shared mcp HTTP path
        except LaptopInvokeTimeout as err:
            raise HTTPException(status_code=504, detail=str(err)) from err
        except (LaptopSendFailed, LaptopInvokeError) as err:
            raise HTTPException(status_code=502, detail=str(err)) from err
    if not _runtime_http_fallback_enabled():
        _raise_runtime_http_fallback_disabled("worktree file write")
    return await _http_worktree_write(req.workItemCode, req.path, body_fields)


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
