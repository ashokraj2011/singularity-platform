from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.database import get_db
from app.models import (
    Capability, CapabilityRelationship, CapabilityMembership,
    CapabilitySharingGrant, BusinessUnit, Team, Role, User,
)
from app.auth.deps import get_current_user
from app.schemas import PageResponse
from app.capabilities.schemas import (
    CapabilityOut, CreateCapabilityRequest, UpdateCapabilityRequest,
    CapabilityRelationshipOut, CreateCapabilityRelationshipRequest,
    CapabilityMembershipOut, AddCapabilityMemberRequest,
    SharingGrantOut, CreateSharingGrantRequest,
)
from app.audit.service import record_event
from datetime import datetime, timezone

router = APIRouter(tags=["capabilities"])


def _cap_out(c: Capability) -> CapabilityOut:
    return CapabilityOut(
        id=c.id, capability_id=c.capability_id, name=c.name, description=c.description,
        capability_type=c.capability_type, status=c.status, visibility=c.visibility,
        owner_bu_id=c.owner_bu_id, owner_team_id=c.owner_team_id,
        metadata=c.metadata_ or {}, tags=c.tags or [], created_by=c.created_by,
        created_at=c.created_at, updated_at=c.updated_at,
    )


def _rel_out(r: CapabilityRelationship) -> CapabilityRelationshipOut:
    return CapabilityRelationshipOut(
        id=r.id, source_capability_id=r.source_capability_id,
        target_capability_id=r.target_capability_id, relationship_type=r.relationship_type,
        inheritance_policy=r.inheritance_policy, metadata=r.metadata_ or {}, created_at=r.created_at,
    )


def _mem_out(m: CapabilityMembership) -> CapabilityMembershipOut:
    return CapabilityMembershipOut(
        id=m.id, capability_id=m.capability_id, user_id=m.user_id, team_id=m.team_id,
        role_id=m.role_id, status=m.status, granted_by=m.granted_by,
        valid_from=m.valid_from, valid_until=m.valid_until,
        metadata=m.metadata_ or {}, created_at=m.created_at,
    )


def _grant_out(g: CapabilitySharingGrant) -> SharingGrantOut:
    return SharingGrantOut(
        id=g.id, provider_capability_id=g.provider_capability_id,
        consumer_capability_id=g.consumer_capability_id, grant_type=g.grant_type,
        allowed_permissions=g.allowed_permissions or [], status=g.status,
        approved_by=g.approved_by, approved_at=g.approved_at,
        metadata=g.metadata_ or {}, created_at=g.created_at,
    )


# ---- Capabilities ----

@router.get("/capabilities", response_model=PageResponse[CapabilityOut])
async def list_capabilities(
    page: int = Query(1, ge=1), size: int = Query(20, ge=1, le=500),
    capability_type: str | None = None,
    db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user),
):
    q = select(Capability)
    if capability_type:
        q = q.where(Capability.capability_type == capability_type)
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.offset((page - 1) * size).limit(size))).scalars().all()
    return PageResponse(items=[_cap_out(c) for c in items], total=total, page=page, size=size)


@router.post("/capabilities", response_model=CapabilityOut, status_code=201)
async def create_capability(
    body: CreateCapabilityRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    existing = (await db.execute(select(Capability).where(Capability.capability_id == body.capability_id))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="capability_id already exists")

    owner_bu_id = None
    if body.owner_bu_key:
        bu = (await db.execute(select(BusinessUnit).where(BusinessUnit.bu_key == body.owner_bu_key))).scalar_one_or_none()
        if bu:
            owner_bu_id = bu.id

    owner_team_id = None
    if body.owner_team_key:
        team = (await db.execute(select(Team).where(Team.team_key == body.owner_team_key))).scalar_one_or_none()
        if team:
            owner_team_id = team.id

    cap = Capability(
        capability_id=body.capability_id, name=body.name, description=body.description,
        capability_type=body.capability_type, visibility=body.visibility,
        owner_bu_id=owner_bu_id, owner_team_id=owner_team_id,
        metadata_=body.metadata or {}, tags=body.tags or [], created_by=current_user.id,
    )
    db.add(cap)
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="capability_created",
                       capability_id=cap.capability_id, target_type="capability", target_id=cap.capability_id,
                       payload={"name": cap.name, "capability_type": cap.capability_type})
    await db.commit()
    await db.refresh(cap)
    return _cap_out(cap)


@router.get("/capabilities/{capability_id}", response_model=CapabilityOut)
async def get_capability(capability_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    cap = (await db.execute(select(Capability).where(Capability.capability_id == capability_id))).scalar_one_or_none()
    if not cap:
        raise HTTPException(status_code=404, detail="Capability not found")
    return _cap_out(cap)


@router.patch("/capabilities/{capability_id}", response_model=CapabilityOut)
async def update_capability(
    capability_id: str, body: UpdateCapabilityRequest,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    cap = (await db.execute(select(Capability).where(Capability.capability_id == capability_id))).scalar_one_or_none()
    if not cap:
        raise HTTPException(status_code=404, detail="Capability not found")
    for field in ("name", "description", "status", "visibility"):
        val = getattr(body, field)
        if val is not None:
            setattr(cap, field, val)
    if body.metadata is not None:
        cap.metadata_ = body.metadata
    if body.tags is not None:
        cap.tags = body.tags
    cap.updated_at = datetime.now(timezone.utc)
    await record_event(db, actor_user_id=current_user.id, event_type="capability_updated",
                       capability_id=capability_id, payload=body.model_dump(exclude_none=True))
    await db.commit()
    await db.refresh(cap)
    return _cap_out(cap)


# ---- Capability Relationships ----

@router.get("/capabilities/{capability_id}/relationships", response_model=list[CapabilityRelationshipOut])
async def list_relationships(capability_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    result = await db.execute(select(CapabilityRelationship).where(CapabilityRelationship.source_capability_id == capability_id))
    return [_rel_out(r) for r in result.scalars().all()]


@router.post("/capabilities/{capability_id}/relationships", response_model=CapabilityRelationshipOut, status_code=201)
async def add_relationship(
    capability_id: str, body: CreateCapabilityRelationshipRequest,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    rel = CapabilityRelationship(
        source_capability_id=capability_id, target_capability_id=body.target_capability_id,
        relationship_type=body.relationship_type, inheritance_policy=body.inheritance_policy,
        metadata_=body.metadata or {}, created_by=current_user.id,
    )
    db.add(rel)
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="capability_relationship_created",
                       capability_id=capability_id, payload={"target": body.target_capability_id, "type": body.relationship_type})
    await db.commit()
    await db.refresh(rel)
    return _rel_out(rel)


# ---- Capability Members ----

@router.get("/capabilities/{capability_id}/members", response_model=list[CapabilityMembershipOut])
async def list_members(capability_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    result = await db.execute(select(CapabilityMembership).where(CapabilityMembership.capability_id == capability_id))
    return [_mem_out(m) for m in result.scalars().all()]


@router.post("/capabilities/{capability_id}/members", response_model=CapabilityMembershipOut, status_code=201)
async def add_member(
    capability_id: str, body: AddCapabilityMemberRequest,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    if not body.user_id and not body.team_id:
        raise HTTPException(status_code=400, detail="user_id or team_id required")

    role = (await db.execute(select(Role).where(Role.role_key == body.role_key))).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{body.role_key}' not found")

    membership = CapabilityMembership(
        capability_id=capability_id, user_id=body.user_id, team_id=body.team_id,
        role_id=role.id, granted_by=current_user.id,
    )
    db.add(membership)
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="capability_member_added",
                       capability_id=capability_id,
                       payload={"user_id": body.user_id, "team_id": body.team_id, "role_key": body.role_key})
    await db.commit()
    await db.refresh(membership)
    return _mem_out(membership)


# ---- Sharing Grants ----

@router.get("/capability-sharing-grants", response_model=PageResponse[SharingGrantOut])
async def list_grants(
    page: int = Query(1, ge=1), size: int = Query(20, ge=1, le=200),
    status: str | None = None,
    db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user),
):
    q = select(CapabilitySharingGrant)
    if status:
        q = q.where(CapabilitySharingGrant.status == status)
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.offset((page - 1) * size).limit(size))).scalars().all()
    return PageResponse(items=[_grant_out(g) for g in items], total=total, page=page, size=size)


@router.post("/capability-sharing-grants", response_model=SharingGrantOut, status_code=201)
async def create_grant(
    body: CreateSharingGrantRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    grant = CapabilitySharingGrant(
        provider_capability_id=body.provider_capability_id,
        consumer_capability_id=body.consumer_capability_id,
        grant_type=body.grant_type, allowed_permissions=body.allowed_permissions,
        metadata_=body.metadata or {},
    )
    db.add(grant)
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="sharing_grant_created",
                       payload={"provider": body.provider_capability_id, "consumer": body.consumer_capability_id})
    await db.commit()
    await db.refresh(grant)
    return _grant_out(grant)


@router.post("/capability-sharing-grants/{grant_id}/approve", response_model=SharingGrantOut)
async def approve_grant(
    grant_id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    grant = (await db.execute(select(CapabilitySharingGrant).where(CapabilitySharingGrant.id == grant_id))).scalar_one_or_none()
    if not grant:
        raise HTTPException(status_code=404, detail="Grant not found")
    grant.approved_by = current_user.id
    grant.approved_at = datetime.now(timezone.utc)
    await record_event(db, actor_user_id=current_user.id, event_type="sharing_grant_approved", payload={"grant_id": grant_id})
    await db.commit()
    await db.refresh(grant)
    return _grant_out(grant)


@router.post("/capability-sharing-grants/{grant_id}/revoke", response_model=SharingGrantOut)
async def revoke_grant(
    grant_id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    grant = (await db.execute(select(CapabilitySharingGrant).where(CapabilitySharingGrant.id == grant_id))).scalar_one_or_none()
    if not grant:
        raise HTTPException(status_code=404, detail="Grant not found")
    grant.status = "revoked"
    await record_event(db, actor_user_id=current_user.id, event_type="sharing_grant_revoked", payload={"grant_id": grant_id})
    await db.commit()
    await db.refresh(grant)
    return _grant_out(grant)
