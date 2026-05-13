"""M26 — Personal MCP device-token surface.

Three endpoints that match `pseudo-iam-service/src/index.ts` exactly so the
`singularity-mcp` CLI + context-fabric `laptop_bridge` can switch between
pseudo + real IAM with no client-side change:

  POST /api/v1/auth/device-token   mint (90-day default)
  GET  /api/v1/me/devices          list mine
  DELETE /api/v1/devices/{id}      revoke (owner only)

Tokens carry `kind:"device"` so consumers can distinguish them from regular
user tokens. The laptop bridge uses the `sub` (user_id), `device_id`, and
`device_name` claims to route invokes and to mark the live connection.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status, Path
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.service import record_event
from app.audit_gov_emit import emit_audit_event
from app.auth.deps import get_current_user
from app.auth.jwt import create_device_token
from app.database import get_db
from app.devices.schemas import DeviceList, DeviceOut, DeviceTokenRequest, DeviceTokenResponse
from app.models import User, UserDevice

router = APIRouter(tags=["devices"])

# Scopes a device JWT can carry. Mirrors the pseudo-IAM list. Anything outside
# this set is silently dropped at mint-time so a compromised client can't
# escalate its own bearer.
_VALID_DEVICE_SCOPES = {
    "mcp:invoke",      # call /mcp/invoke on its own laptop process
    "mcp:resume",      # /mcp/resume — required to clear approval pauses
    "tools:execute",   # exec local + server-side tools
    "git:read",        # read-only git ops
    "git:write",       # commit + push (the dangerous ones)
    "fs:read",         # read inside allowed_paths
    "fs:write",        # write inside allowed_paths
}


def _to_out(device: UserDevice) -> DeviceOut:
    return DeviceOut(
        id=device.id,
        user_id=device.user_id,
        device_id=device.device_id,
        device_name=device.device_name,
        scopes=list(device.scopes or []),
        created_at=device.created_at,
        last_seen_at=device.last_seen_at,
        revoked_at=device.revoked_at,
    )


@router.post("/auth/device-token", response_model=DeviceTokenResponse, status_code=201)
async def mint_device_token(
    body: DeviceTokenRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mint a long-lived device JWT for the calling user's laptop.

    Idempotent on `(user_id, device_id)` — calling again with the same
    `device_id` returns a freshly-signed token but reuses the row (and bumps
    `created_at`). Revoking sets `revoked_at`; the next mint clears it.
    """
    device_id = body.device_id or str(uuid.uuid4())
    device_name = body.device_name or "unknown-device"
    requested_scopes = list(body.scopes or [])
    invalid = [s for s in requested_scopes if s not in _VALID_DEVICE_SCOPES]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"unknown scopes: {invalid}; valid={sorted(_VALID_DEVICE_SCOPES)}",
        )
    scopes = requested_scopes or sorted(_VALID_DEVICE_SCOPES)

    existing_q = await db.execute(
        select(UserDevice).where(
            UserDevice.user_id == current_user.id,
            UserDevice.device_id == device_id,
        )
    )
    device = existing_q.scalar_one_or_none()
    if device is None:
        device = UserDevice(
            user_id=current_user.id,
            device_id=device_id,
            device_name=device_name,
            scopes=scopes,
        )
        db.add(device)
    else:
        # Re-mint resurrects a previously-revoked device. The user has the
        # bearer in hand already so this is the right place to do it.
        device.device_name = device_name
        device.scopes = scopes
        device.revoked_at = None
    await db.flush()

    token = create_device_token(
        user_id=current_user.id,
        email=current_user.email,
        device_id=device_id,
        device_name=device_name,
        scopes=scopes,
        ttl_days=body.ttl_days,
    )

    await record_event(
        db, actor_user_id=current_user.id, event_type="device_token_minted",
        payload={
            "device_id": device_id,
            "device_name": device_name,
            "scopes": scopes,
            "ttl_days": body.ttl_days,
        },
    )
    await db.commit()

    emit_audit_event(
        kind="iam.device.token.minted",
        actor_id=current_user.id,
        subject_type="UserDevice",
        subject_id=device.id,
        severity="info",
        payload={
            "user_id": current_user.id,
            "device_id": device_id,
            "device_name": device_name,
            "scopes": scopes,
            "ttl_days": body.ttl_days,
        },
    )

    return DeviceTokenResponse(
        access_token=token,
        device_id=device_id,
        user_id=current_user.id,
        email=current_user.email,
        device_name=device_name,
        scopes=scopes,
        expires_in_days=body.ttl_days,
    )


@router.get("/me/devices", response_model=DeviceList)
async def list_my_devices(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = await db.execute(
        select(UserDevice)
        .where(UserDevice.user_id == current_user.id)
        .order_by(UserDevice.created_at.desc()),
    )
    items = [_to_out(d) for d in q.scalars().all()]
    return DeviceList(items=items, total=len(items))


@router.delete("/devices/{device_pk}", status_code=200)
async def revoke_device(
    device_pk: str = Path(..., description="UserDevice.id (row PK), NOT the client-generated device_id"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark a device as revoked. The laptop bridge sweeps every 60s and
    drops live connections whose device row has `revoked_at` set (M26 A2)."""
    q = await db.execute(select(UserDevice).where(UserDevice.id == device_pk))
    device = q.scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="device not found")
    if device.user_id != current_user.id and not current_user.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="cannot revoke a device that doesn't belong to you",
        )
    if device.revoked_at is None:
        device.revoked_at = datetime.now(timezone.utc)
        await db.flush()
        await record_event(
            db, actor_user_id=current_user.id, event_type="device_revoked",
            payload={"device_id": device.device_id, "device_pk": device.id},
        )
        await db.commit()
        emit_audit_event(
            kind="iam.device.revoked",
            actor_id=current_user.id,
            subject_type="UserDevice",
            subject_id=device.id,
            severity="warn",
            payload={
                "user_id": device.user_id,
                "device_id": device.device_id,
                "device_name": device.device_name,
            },
        )
    return {"ok": True, "device": _to_out(device).model_dump()}
