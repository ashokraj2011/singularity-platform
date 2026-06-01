from typing import Optional
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.database import get_db
from app.models import BusinessUnit, Team, TeamMembership, User, Capability, CapabilityMembership, Role
from app.auth.deps import get_current_user
from app.schemas import PageResponse
from app.org.schemas import (
    BusinessUnitOut, CreateBusinessUnitRequest, UpdateBusinessUnitRequest, SetChildBuRequest,
    TeamOut, CreateTeamRequest, UpdateTeamRequest, SetChildTeamRequest,
    TeamMembershipOut, AddTeamMemberRequest,
)
from app.audit.service import record_event
from datetime import datetime, timezone

router = APIRouter(tags=["org"])


def _bu_out(b: BusinessUnit) -> BusinessUnitOut:
    return BusinessUnitOut(
        id=b.id, bu_key=b.bu_key, name=b.name, description=b.description,
        parent_bu_id=b.parent_bu_id, metadata=b.metadata_ or {}, tags=b.tags or [],
        created_at=b.created_at, updated_at=b.updated_at,
    )


def _team_out(t: Team) -> TeamOut:
    return TeamOut(
        id=t.id, team_key=t.team_key, name=t.name, description=t.description,
        bu_id=t.bu_id, parent_team_id=t.parent_team_id,
        metadata=t.metadata_ or {}, tags=t.tags or [],
        created_at=t.created_at, updated_at=t.updated_at,
    )


async def _capability_memberships_for_user(db: AsyncSession, user_id: str) -> list[dict]:
    team_ids_result = await db.execute(select(TeamMembership.team_id).where(TeamMembership.user_id == user_id))
    team_ids = list(team_ids_result.scalars().all())

    q = select(CapabilityMembership).where(
        CapabilityMembership.status == "active",
        CapabilityMembership.user_id == user_id,
    )
    if team_ids:
        q = select(CapabilityMembership).where(
            CapabilityMembership.status == "active",
            (CapabilityMembership.user_id == user_id) | (CapabilityMembership.team_id.in_(team_ids)),
        )

    memberships = (await db.execute(q)).scalars().all()
    out: list[dict] = []
    for membership in memberships:
        capability = (await db.execute(
            select(Capability).where(Capability.capability_id == membership.capability_id)
        )).scalar_one_or_none()
        role = (await db.execute(select(Role).where(Role.id == membership.role_id))).scalar_one_or_none()
        team = None
        if membership.team_id:
            team = (await db.execute(select(Team).where(Team.id == membership.team_id))).scalar_one_or_none()

        role_key = role.role_key if role else ""
        out.append({
            "capability_id": membership.capability_id,
            "capability_name": capability.name if capability else membership.capability_id,
            "team_id": membership.team_id or "",
            "team_name": team.name if team else "Direct membership",
            "role_key": role_key,
            "role_name": role.name if role else role_key,
            "is_capability_owner": role_key in {"super_admin", "platform_admin", "capability_admin"},
        })
    return out


# ---- Business Units ----

@router.get("/business-units", response_model=PageResponse[BusinessUnitOut])
async def list_bus(
    page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user),
):
    q = select(BusinessUnit)
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.offset((page - 1) * size).limit(size))).scalars().all()
    return PageResponse(items=[_bu_out(b) for b in items], total=total, page=page, size=size)


@router.post("/business-units", response_model=BusinessUnitOut, status_code=201)
async def create_bu(
    body: CreateBusinessUnitRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    existing = (await db.execute(select(BusinessUnit).where(BusinessUnit.bu_key == body.bu_key))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="bu_key already exists")

    bu = BusinessUnit(
        bu_key=body.bu_key, name=body.name, description=body.description,
        parent_bu_id=body.parent_bu_id, metadata_=body.metadata or {}, tags=body.tags or [],
    )
    db.add(bu)
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="business_unit_created",
                       target_type="business_unit", target_id=bu.id, payload={"bu_key": bu.bu_key})
    await db.commit()
    await db.refresh(bu)
    return _bu_out(bu)


@router.get("/business-units/{bu_id}", response_model=BusinessUnitOut)
async def get_bu(bu_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    bu = (await db.execute(select(BusinessUnit).where(BusinessUnit.id == bu_id))).scalar_one_or_none()
    if not bu:
        raise HTTPException(status_code=404, detail="Business unit not found")
    return _bu_out(bu)


async def _assert_no_bu_cycle(db: AsyncSession, bu_id: str, new_parent_id: str) -> None:
    """Reject a parent assignment that would create a cycle in the BU tree.

    Walk UP from new_parent_id via parent_bu_id; if we reach bu_id it would
    form a loop. Rejects self-parenting; depth-capped against bad data.
    """
    if new_parent_id == bu_id:
        raise HTTPException(status_code=400, detail="A business unit cannot be its own parent")
    seen: set[str] = set()
    cursor: Optional[str] = new_parent_id
    depth = 0
    while cursor is not None and depth < 100:
        if cursor == bu_id:
            raise HTTPException(status_code=400, detail="parent_bu_id would create a cycle")
        if cursor in seen:
            break
        seen.add(cursor)
        parent = (await db.execute(select(BusinessUnit.parent_bu_id).where(BusinessUnit.id == cursor))).scalar_one_or_none()
        cursor = parent
        depth += 1


@router.patch("/business-units/{bu_id}", response_model=BusinessUnitOut)
async def update_bu(
    bu_id: str,
    body: UpdateBusinessUnitRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    bu = (await db.execute(select(BusinessUnit).where(BusinessUnit.id == bu_id))).scalar_one_or_none()
    if not bu:
        raise HTTPException(status_code=404, detail="Business unit not found")
    provided = body.provided_fields()
    if "name" in provided and body.name is not None:
        if not body.name.strip():
            raise HTTPException(status_code=400, detail="name cannot be empty")
        bu.name = body.name.strip()
    if "description" in provided:
        bu.description = body.description
    if "parent_bu_id" in provided:
        if body.parent_bu_id:
            parent = (await db.execute(select(BusinessUnit.id).where(BusinessUnit.id == body.parent_bu_id))).scalar_one_or_none()
            if not parent:
                raise HTTPException(status_code=400, detail="parent_bu_id does not exist")
            await _assert_no_bu_cycle(db, bu_id, body.parent_bu_id)
            bu.parent_bu_id = body.parent_bu_id
        else:
            bu.parent_bu_id = None
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="business_unit_updated",
                       target_type="business_unit", target_id=bu.id, payload={"fields": sorted(provided)})
    await db.commit()
    await db.refresh(bu)
    return _bu_out(bu)


@router.get("/business-units/{bu_id}/children", response_model=list[BusinessUnitOut])
async def list_child_bus(bu_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    bu = (await db.execute(select(BusinessUnit.id).where(BusinessUnit.id == bu_id))).scalar_one_or_none()
    if not bu:
        raise HTTPException(status_code=404, detail="Business unit not found")
    rows = (await db.execute(
        select(BusinessUnit).where(BusinessUnit.parent_bu_id == bu_id).order_by(BusinessUnit.name)
    )).scalars().all()
    return [_bu_out(b) for b in rows]


@router.post("/business-units/{bu_id}/children", response_model=BusinessUnitOut, status_code=201)
async def add_child_bu(
    bu_id: str,
    body: SetChildBuRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Re-parent an existing business unit under {bu_id}."""
    parent = (await db.execute(select(BusinessUnit.id).where(BusinessUnit.id == bu_id))).scalar_one_or_none()
    if not parent:
        raise HTTPException(status_code=404, detail="Business unit not found")
    child = (await db.execute(select(BusinessUnit).where(BusinessUnit.id == body.child_bu_id))).scalar_one_or_none()
    if not child:
        raise HTTPException(status_code=400, detail="child_bu_id does not exist")
    if child.id == bu_id:
        raise HTTPException(status_code=400, detail="A business unit cannot be its own child")
    await _assert_no_bu_cycle(db, child.id, bu_id)
    child.parent_bu_id = bu_id
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="business_unit_updated",
                       target_type="business_unit", target_id=child.id, payload={"parent_bu_id": bu_id})
    await db.commit()
    await db.refresh(child)
    return _bu_out(child)


# ---- Teams ----

@router.get("/teams", response_model=PageResponse[TeamOut])
async def list_teams(
    page: int = Query(1, ge=1), size: int = Query(20, ge=1, le=200),
    db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user),
):
    q = select(Team)
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.offset((page - 1) * size).limit(size))).scalars().all()
    return PageResponse(items=[_team_out(t) for t in items], total=total, page=page, size=size)


@router.post("/teams", response_model=TeamOut, status_code=201)
async def create_team(
    body: CreateTeamRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    existing = (await db.execute(select(Team).where(Team.team_key == body.team_key))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="team_key already exists")

    bu_id = None
    if body.bu_key:
        bu = (await db.execute(select(BusinessUnit).where(BusinessUnit.bu_key == body.bu_key))).scalar_one_or_none()
        if bu:
            bu_id = bu.id

    team = Team(
        team_key=body.team_key, name=body.name, description=body.description,
        bu_id=bu_id, parent_team_id=body.parent_team_id,
        metadata_=body.metadata or {}, tags=body.tags or [],
    )
    db.add(team)
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="team_created",
                       target_type="team", target_id=team.id, payload={"team_key": team.team_key})
    await db.commit()
    await db.refresh(team)
    return _team_out(team)


@router.get("/teams/{team_id}", response_model=TeamOut)
async def get_team(team_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    team = (await db.execute(select(Team).where(Team.id == team_id))).scalar_one_or_none()
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    return _team_out(team)


async def _assert_no_team_cycle(db: AsyncSession, team_id: str, new_parent_id: str) -> None:
    """Reject a parent assignment that would create a cycle.

    Walk UP from new_parent_id following parent_team_id; if we reach team_id,
    setting it as the parent would form a loop. Also rejects self-parenting.
    Bounded by a depth cap as a backstop against pre-existing bad data.
    """
    if new_parent_id == team_id:
        raise HTTPException(status_code=400, detail="A team cannot be its own parent")
    seen: set[str] = set()
    cursor: Optional[str] = new_parent_id
    depth = 0
    while cursor is not None and depth < 100:
        if cursor == team_id:
            raise HTTPException(status_code=400, detail="parent_team_id would create a cycle")
        if cursor in seen:  # pre-existing loop in data — stop, don't hang
            break
        seen.add(cursor)
        parent = (await db.execute(select(Team.parent_team_id).where(Team.id == cursor))).scalar_one_or_none()
        cursor = parent
        depth += 1


@router.patch("/teams/{team_id}", response_model=TeamOut)
async def update_team(
    team_id: str,
    body: UpdateTeamRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    team = (await db.execute(select(Team).where(Team.id == team_id))).scalar_one_or_none()
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    provided = body.provided_fields()
    if "name" in provided and body.name is not None:
        if not body.name.strip():
            raise HTTPException(status_code=400, detail="name cannot be empty")
        team.name = body.name.strip()
    if "description" in provided:
        team.description = body.description
    if "parent_team_id" in provided:
        if body.parent_team_id:
            parent = (await db.execute(select(Team.id).where(Team.id == body.parent_team_id))).scalar_one_or_none()
            if not parent:
                raise HTTPException(status_code=400, detail="parent_team_id does not exist")
            await _assert_no_team_cycle(db, team_id, body.parent_team_id)
            team.parent_team_id = body.parent_team_id
        else:
            team.parent_team_id = None  # explicit null → detach to root
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="team_updated",
                       target_type="team", target_id=team.id, payload={"fields": sorted(provided)})
    await db.commit()
    await db.refresh(team)
    return _team_out(team)


@router.get("/teams/{team_id}/children", response_model=list[TeamOut])
async def list_child_teams(team_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    team = (await db.execute(select(Team.id).where(Team.id == team_id))).scalar_one_or_none()
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    rows = (await db.execute(
        select(Team).where(Team.parent_team_id == team_id).order_by(Team.name)
    )).scalars().all()
    return [_team_out(t) for t in rows]


@router.post("/teams/{team_id}/children", response_model=TeamOut, status_code=201)
async def add_child_team(
    team_id: str,
    body: SetChildTeamRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Re-parent an existing team under {team_id} (sets the child's parent)."""
    parent = (await db.execute(select(Team.id).where(Team.id == team_id))).scalar_one_or_none()
    if not parent:
        raise HTTPException(status_code=404, detail="Team not found")
    child = (await db.execute(select(Team).where(Team.id == body.child_team_id))).scalar_one_or_none()
    if not child:
        raise HTTPException(status_code=400, detail="child_team_id does not exist")
    if child.id == team_id:
        raise HTTPException(status_code=400, detail="A team cannot be its own child")
    # Guard the cycle FROM THE CHILD's perspective: making team_id the child's
    # parent must not create a loop.
    await _assert_no_team_cycle(db, child.id, team_id)
    child.parent_team_id = team_id
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="team_updated",
                       target_type="team", target_id=child.id, payload={"parent_team_id": team_id})
    await db.commit()
    await db.refresh(child)
    return _team_out(child)


@router.get("/teams/{team_id}/members", response_model=list[TeamMembershipOut])
async def list_team_members(team_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    result = await db.execute(select(TeamMembership).where(TeamMembership.team_id == team_id))
    members = result.scalars().all()
    return [TeamMembershipOut(id=m.id, team_id=m.team_id, user_id=m.user_id,
                               membership_type=m.membership_type, created_at=m.created_at) for m in members]


@router.get("/users/{user_id}/teams", response_model=list[TeamOut])
async def list_user_teams(user_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    result = await db.execute(
        select(Team)
        .join(TeamMembership, TeamMembership.team_id == Team.id)
        .where(TeamMembership.user_id == user_id)
    )
    return [_team_out(t) for t in result.scalars().all()]


@router.get("/users/{user_id}/memberships")
async def list_user_memberships(user_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    return await _capability_memberships_for_user(db, user_id)


@router.get("/me/memberships")
async def list_my_memberships(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await _capability_memberships_for_user(db, current_user.id)


@router.post("/teams/{team_id}/members", response_model=TeamMembershipOut, status_code=201)
async def add_team_member(
    team_id: str,
    body: AddTeamMemberRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    team = (await db.execute(select(Team).where(Team.id == team_id))).scalar_one_or_none()
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")

    existing = (await db.execute(
        select(TeamMembership).where(TeamMembership.team_id == team_id, TeamMembership.user_id == body.user_id)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="User already a member")

    membership = TeamMembership(team_id=team_id, user_id=body.user_id, membership_type=body.membership_type)
    db.add(membership)
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="team_member_added",
                       target_type="team", target_id=team_id, payload={"user_id": body.user_id})
    await db.commit()
    await db.refresh(membership)
    return TeamMembershipOut(id=membership.id, team_id=membership.team_id, user_id=membership.user_id,
                              membership_type=membership.membership_type, created_at=membership.created_at)


@router.delete("/teams/{team_id}/members/{user_id}", status_code=204)
async def remove_team_member(
    team_id: str, user_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    membership = (await db.execute(
        select(TeamMembership).where(TeamMembership.team_id == team_id, TeamMembership.user_id == user_id)
    )).scalar_one_or_none()
    if not membership:
        raise HTTPException(status_code=404, detail="Membership not found")
    await db.delete(membership)
    await record_event(db, actor_user_id=current_user.id, event_type="team_member_removed",
                       target_type="team", target_id=team_id, payload={"user_id": user_id})
    await db.commit()
