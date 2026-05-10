"""Skills catalog routes — v0 (CRUD + list/get-by-key).

Skills are owned by IAM so the rest of the platform (workgraph assignment
routing SKILL_BASED, agent-runtime AgentTemplate.skills) can reference one
source of truth. Membership tables (UserSkill / AgentSkill) live elsewhere
and reference skill_key here.
"""
from __future__ import annotations

from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Skill, User
from app.auth.deps import get_current_user

router = APIRouter(prefix="/skills", tags=["skills"])


# ── schemas ────────────────────────────────────────────────────────────────

class SkillIn(BaseModel):
    skill_key:   str = Field(..., min_length=1, max_length=64)
    name:        str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    category:    Optional[str] = None
    metadata:    Optional[dict] = None


class SkillOut(BaseModel):
    id:          str
    skill_key:   str
    name:        str
    description: Optional[str]
    category:    Optional[str]
    metadata:    dict
    created_at:  str
    updated_at:  str


class SkillPage(BaseModel):
    items: List[SkillOut]
    total: int
    page:  int
    size:  int


def _to_out(s: Skill) -> SkillOut:
    return SkillOut(
        id=s.id, skill_key=s.skill_key, name=s.name, description=s.description,
        category=s.category, metadata=s.metadata_ or {},
        created_at=s.created_at.isoformat(), updated_at=s.updated_at.isoformat(),
    )


# ── routes ─────────────────────────────────────────────────────────────────

@router.post("", response_model=SkillOut, status_code=201)
async def create_skill(
    body: SkillIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not current_user.is_super_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super-admin required")
    existing = (await db.execute(select(Skill).where(Skill.skill_key == body.skill_key))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail=f"skill_key already exists: {body.skill_key}")
    s = Skill(
        skill_key=body.skill_key, name=body.name, description=body.description,
        category=body.category, metadata_=body.metadata or {},
        created_by=getattr(current_user, "id", None) if not getattr(current_user, "id", "").startswith("service:") else None,
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return _to_out(s)


@router.get("", response_model=SkillPage)
async def list_skills(
    page:     int = Query(default=1, ge=1),
    size:     int = Query(default=50, ge=1, le=200),
    category: Optional[str] = Query(default=None),
    q:        Optional[str] = Query(default=None, description="Substring match on skill_key or name"),
    db:       AsyncSession = Depends(get_db),
    _:        User = Depends(get_current_user),
):
    base = select(Skill)
    if category:
        base = base.where(Skill.category == category)
    if q:
        like = f"%{q.lower()}%"
        from sqlalchemy import func, or_
        base = base.where(or_(func.lower(Skill.skill_key).like(like), func.lower(Skill.name).like(like)))
    base = base.order_by(Skill.skill_key.asc())

    rows = (await db.execute(base.offset((page - 1) * size).limit(size))).scalars().all()
    # Cheap total — list comes back small in practice
    total = len((await db.execute(base)).scalars().all())
    return SkillPage(items=[_to_out(r) for r in rows], total=total, page=page, size=size)


@router.get("/{skill_key}", response_model=SkillOut)
async def get_skill(
    skill_key: str,
    db: AsyncSession = Depends(get_db),
    _:  User = Depends(get_current_user),
):
    s = (await db.execute(select(Skill).where(Skill.skill_key == skill_key))).scalar_one_or_none()
    if s is None:
        raise HTTPException(status_code=404, detail=f"skill not found: {skill_key}")
    return _to_out(s)
