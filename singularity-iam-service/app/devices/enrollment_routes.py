from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.service import record_event
from app.audit_gov_emit import emit_audit_event
from app.auth.deps import require_real_user
from app.auth.jwt import create_device_token
from app.database import get_db
from app.devices.enrollment_schemas import (
    RuntimeEnrollmentExchangeRequest,
    RuntimeEnrollmentExchangeResponse,
    RuntimeEnrollmentRequest,
    RuntimeEnrollmentResponse,
)
from app.devices.routes import _VALID_DEVICE_SCOPES, _VALID_RUNTIME_FRAMES
from app.models import RuntimeEnrollment, User, UserDevice

router = APIRouter(tags=["runtime-enrollment"])


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_code(value: str) -> str:
    return "".join(value.upper().replace("-", "").split())


def _code_hash(value: str) -> str:
    return hashlib.sha256(_normalize_code(value).encode("utf-8")).hexdigest()


def _new_code() -> str:
    raw = secrets.token_hex(16).upper()
    return "SGR-" + "-".join(raw[index:index + 4] for index in range(0, len(raw), 4))


def _validate_list(values: list[str], allowed: set[str], label: str) -> list[str]:
    cleaned = sorted({value.strip() for value in values if value and value.strip()})
    invalid = [value for value in cleaned if value not in allowed]
    if invalid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unknown {label}: {invalid}; valid={sorted(allowed)}",
        )
    return cleaned


@router.post("/auth/runtime-enrollments", response_model=RuntimeEnrollmentResponse, status_code=201)
async def create_runtime_enrollment(
    body: RuntimeEnrollmentRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_real_user),
):
    if body.runtime_scope in {"tenant", "shared"} and not current_user.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only a super admin can create tenant or shared runtime enrollments",
        )
    if body.runtime_scope in {"tenant", "shared"} and not body.tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required for tenant or shared runtimes")

    scopes = _validate_list(list(body.scopes or _VALID_DEVICE_SCOPES), _VALID_DEVICE_SCOPES, "scopes")
    frames = _validate_list(list(body.allowed_frame_types or _VALID_RUNTIME_FRAMES), _VALID_RUNTIME_FRAMES, "frame types")
    tags = sorted({value.strip() for value in (body.capability_tags or ["mcp", "tools", "llm"]) if value and value.strip()})
    code = _new_code()
    enrollment = RuntimeEnrollment(
        code_hash=_code_hash(code),
        user_id=current_user.id,
        tenant_id=body.tenant_id,
        runtime_name=body.runtime_name.strip(),
        runtime_scope=body.runtime_scope,
        scopes=scopes,
        allowed_frame_types=frames,
        capability_tags=tags,
        token_ttl_days=body.token_ttl_days,
        expires_at=_utcnow() + timedelta(minutes=body.ttl_minutes),
    )
    db.add(enrollment)
    await db.flush()
    await record_event(
        db,
        actor_user_id=current_user.id,
        event_type="runtime_enrollment_created",
        payload={
            "enrollment_id": enrollment.id,
            "runtime_name": enrollment.runtime_name,
            "runtime_scope": enrollment.runtime_scope,
            "tenant_id": enrollment.tenant_id,
            "expires_at": enrollment.expires_at.isoformat(),
        },
    )
    await db.commit()
    emit_audit_event(
        kind="iam.runtime.enrollment.created",
        actor_id=current_user.id,
        subject_type="RuntimeEnrollment",
        subject_id=enrollment.id,
        severity="info",
        payload={
            "runtime_name": enrollment.runtime_name,
            "runtime_scope": enrollment.runtime_scope,
            "tenant_id": enrollment.tenant_id,
            "expires_at": enrollment.expires_at.isoformat(),
        },
    )
    return RuntimeEnrollmentResponse(
        enrollment_id=enrollment.id,
        code=code,
        runtime_name=enrollment.runtime_name,
        runtime_scope=enrollment.runtime_scope,
        tenant_id=enrollment.tenant_id,
        expires_at=enrollment.expires_at,
        token_ttl_days=enrollment.token_ttl_days,
    )


@router.post("/auth/runtime-enrollments/exchange", response_model=RuntimeEnrollmentExchangeResponse)
async def exchange_runtime_enrollment(
    body: RuntimeEnrollmentExchangeRequest,
    db: AsyncSession = Depends(get_db),
):
    """Consume a browser-created code and mint a runtime JWT exactly once."""
    query = await db.execute(
        select(RuntimeEnrollment)
        .where(RuntimeEnrollment.code_hash == _code_hash(body.code))
        .with_for_update()
    )
    enrollment = query.scalar_one_or_none()
    now = _utcnow()
    if enrollment is None:
        raise HTTPException(status_code=400, detail="Invalid runtime enrollment code")
    if enrollment.used_at is not None:
        raise HTTPException(status_code=409, detail="Runtime enrollment code has already been used")
    if enrollment.expires_at <= now:
        raise HTTPException(status_code=410, detail="Runtime enrollment code has expired")

    user = await db.get(User, enrollment.user_id)
    if user is None or user.status != "active":
        raise HTTPException(status_code=401, detail="Enrollment owner is no longer active")

    device_id = body.device_id or str(uuid.uuid4())
    device_name = (body.device_name or enrollment.runtime_name).strip()
    existing = await db.scalar(
        select(UserDevice).where(UserDevice.user_id == user.id, UserDevice.device_id == device_id)
    )
    if existing is None:
        device = UserDevice(
            user_id=user.id,
            device_id=device_id,
            device_name=device_name,
            scopes=list(enrollment.scopes or []),
        )
        db.add(device)
    else:
        device = existing
        device.device_name = device_name
        device.scopes = list(enrollment.scopes or [])
        device.revoked_at = None
    await db.flush()

    token = create_device_token(
        user_id=user.id,
        email=user.email,
        device_id=device_id,
        device_name=device_name,
        scopes=list(enrollment.scopes or []),
        ttl_days=enrollment.token_ttl_days,
        token_kind="runtime",
        tenant_id=enrollment.tenant_id,
        runtime_type="mcp",
        runtime_scope=enrollment.runtime_scope,
        allowed_frame_types=list(enrollment.allowed_frame_types or []),
        capability_tags=list(enrollment.capability_tags or []),
    )
    enrollment.used_at = now
    enrollment.used_device_id = device_id
    await record_event(
        db,
        actor_user_id=user.id,
        event_type="runtime_enrollment_exchanged",
        payload={
            "enrollment_id": enrollment.id,
            "runtime_id": device_id,
            "runtime_scope": enrollment.runtime_scope,
            "tenant_id": enrollment.tenant_id,
        },
    )
    await db.commit()
    emit_audit_event(
        kind="iam.runtime.enrollment.exchanged",
        actor_id=user.id,
        subject_type="UserDevice",
        subject_id=device.id,
        severity="info",
        payload={
            "enrollment_id": enrollment.id,
            "runtime_id": device_id,
            "runtime_scope": enrollment.runtime_scope,
            "tenant_id": enrollment.tenant_id,
        },
    )
    return RuntimeEnrollmentExchangeResponse(
        access_token=token,
        runtime_id=device_id,
        device_id=device_id,
        user_id=user.id,
        email=user.email,
        runtime_name=device_name,
        runtime_scope=enrollment.runtime_scope,
        tenant_id=enrollment.tenant_id,
        scopes=list(enrollment.scopes or []),
        allowed_frame_types=list(enrollment.allowed_frame_types or []),
        capability_tags=list(enrollment.capability_tags or []),
        expires_in_days=enrollment.token_ttl_days,
    )
