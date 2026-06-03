import uuid
from datetime import datetime, timezone
from uuid import UUID as _UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Capability, CapabilityRelationship, GovernanceAttachment, User
from app.auth.deps import get_current_user
from app.governance.schemas import (
    CreateGovernedByRequest, GovernanceAttachmentOut, GovernanceResolveRequest,
)
from app.governance.resolver import resolve_overlay, MODE_RANK, SCOPE_RANK

router = APIRouter(tags=["governance"])

GOVERNED_BY = "governed_by"


def _actor(u) -> str | None:
    """created_by FK references iam.users.id (UUID); service principals have a
    non-UUID id, so return None for them rather than violating the FK."""
    raw = str(getattr(u, "id", "") or "")
    try:
        _UUID(raw)
        return raw
    except ValueError:
        return None


def _att_out(a: GovernanceAttachment) -> GovernanceAttachmentOut:
    return GovernanceAttachmentOut(
        id=a.id, relationship_id=a.relationship_id, capability_id=a.capability_id,
        governing_capability_id=a.governing_capability_id, mode=a.mode, scope=a.scope,
        target_kind=a.target_kind, target_key=a.target_key, priority=a.priority,
        is_active=a.is_active, effective_from=a.effective_from, effective_to=a.effective_to,
        waiver_allowed=a.waiver_allowed, version=a.version, contributions=a.contributions or {},
        created_at=a.created_at,
    )


async def _get_cap(db: AsyncSession, cap_id: str) -> Capability | None:
    return (await db.execute(
        select(Capability).where(Capability.capability_id == cap_id)
    )).scalar_one_or_none()


@router.post("/capabilities/{capability_id}/governed-by",
             response_model=GovernanceAttachmentOut, status_code=201)
async def attach_governance(
    capability_id: str, body: CreateGovernedByRequest,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    mode = body.mode.strip().upper()
    scope = body.scope.strip().upper()
    if mode not in MODE_RANK:
        raise HTTPException(422, f"invalid mode {body.mode!r}; expected one of {sorted(MODE_RANK)}")
    if scope not in SCOPE_RANK:
        raise HTTPException(422, f"invalid scope {body.scope!r}; expected one of {sorted(SCOPE_RANK)}")
    if capability_id == body.governing_capability_id:
        raise HTTPException(422, "a capability cannot govern itself")

    governed = await _get_cap(db, capability_id)
    if governed is None:
        raise HTTPException(404, f"capability {capability_id!r} not found")
    governing = await _get_cap(db, body.governing_capability_id)
    if governing is None:
        raise HTTPException(404, f"governing capability {body.governing_capability_id!r} not found")

    # Reuse the governed_by edge if it exists; else create it.
    rel = (await db.execute(select(CapabilityRelationship).where(
        CapabilityRelationship.source_capability_id == capability_id,
        CapabilityRelationship.target_capability_id == body.governing_capability_id,
        CapabilityRelationship.relationship_type == GOVERNED_BY,
    ))).scalar_one_or_none()
    if rel is None:
        rel = CapabilityRelationship(
            source_capability_id=capability_id,
            target_capability_id=body.governing_capability_id,
            relationship_type=GOVERNED_BY,
            inheritance_policy=body.inheritance_policy,
            metadata_={}, created_by=_actor(current_user),
        )
        db.add(rel)
        await db.flush()

    att = GovernanceAttachment(
        relationship_id=rel.id, capability_id=capability_id,
        governing_capability_id=body.governing_capability_id,
        mode=mode, scope=scope, target_kind=body.target_kind, target_key=body.target_key,
        priority=body.priority, effective_from=body.effective_from, effective_to=body.effective_to,
        waiver_allowed=body.waiver_allowed, contributions=body.contributions or {},
        created_by=_actor(current_user),
    )
    db.add(att)
    # Role marker: the target is now (at least) a governing capability.
    if not governing.is_governing:
        governing.is_governing = True
    await db.flush()
    await db.commit()
    await db.refresh(att)
    return _att_out(att)


@router.get("/capabilities/{capability_id}/governed-by",
            response_model=list[GovernanceAttachmentOut])
async def list_governed_by(
    capability_id: str, include_inactive: bool = False,
    db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user),
):
    q = select(GovernanceAttachment).where(GovernanceAttachment.capability_id == capability_id)
    if not include_inactive:
        q = q.where(GovernanceAttachment.is_active.is_(True))
    rows = (await db.execute(q)).scalars().all()
    return [_att_out(a) for a in rows]


@router.get("/capabilities/{capability_id}/governs",
            response_model=list[GovernanceAttachmentOut])
async def list_governs(
    capability_id: str,
    db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user),
):
    rows = (await db.execute(select(GovernanceAttachment).where(
        GovernanceAttachment.governing_capability_id == capability_id
    ))).scalars().all()
    return [_att_out(a) for a in rows]


@router.post("/governance/resolve")
async def resolve_governance(
    body: GovernanceResolveRequest,
    db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user),
):
    rows = (await db.execute(select(GovernanceAttachment).where(
        GovernanceAttachment.capability_id == body.capability_id,
        GovernanceAttachment.is_active.is_(True),
    ))).scalars().all()

    gids = {r.governing_capability_id for r in rows}
    names: dict[str, str] = {}
    if gids:
        caps = (await db.execute(
            select(Capability).where(Capability.capability_id.in_(gids))
        )).scalars().all()
        names = {c.capability_id: c.name for c in caps}

    attachments = [{
        "id": r.id,
        "governing_capability_id": r.governing_capability_id,
        "governing_name": names.get(r.governing_capability_id),
        "mode": r.mode, "scope": r.scope,
        "target_kind": r.target_kind, "target_key": r.target_key,
        "priority": r.priority, "is_active": r.is_active,
        "effective_from": r.effective_from, "effective_to": r.effective_to,
        "waiver_allowed": r.waiver_allowed, "version": r.version,
        "contributions": r.contributions or {},
    } for r in rows]

    ctx = {
        "governedCapabilityId": body.capability_id,
        "workItemType": body.work_item_type, "workflowType": body.workflow_type,
        "workflowId": body.workflow_id, "stageKey": body.stage_key,
        "agentRole": body.agent_role, "nodeId": body.node_id, "riskLevel": body.risk_level,
    }
    overlay = resolve_overlay(ctx, attachments, datetime.now(timezone.utc))
    overlay["overlayId"] = "gov_overlay_" + uuid.uuid4().hex[:16]
    overlay["resolvedAt"] = datetime.now(timezone.utc).isoformat()
    return {"success": True, "data": overlay}
