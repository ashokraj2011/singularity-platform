from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.database import get_db
from app.models import Role, Permission, RolePermission, User
from app.auth.deps import get_current_user
from app.schemas import PageResponse
from app.roles.schemas import RoleOut, PermissionOut, CreateRoleRequest, AssignPermissionRequest
from app.audit.service import record_event
from datetime import datetime, timezone

router = APIRouter(tags=["roles"])


def _role_out(r: Role) -> RoleOut:
    return RoleOut(id=r.id, role_key=r.role_key, name=r.name, description=r.description,
                   role_scope=r.role_scope, system_role=r.system_role,
                   metadata=r.metadata_ or {}, tags=r.tags or [],
                   created_at=r.created_at, updated_at=r.updated_at)


def _perm_out(p: Permission) -> PermissionOut:
    return PermissionOut(id=p.id, permission_key=p.permission_key, description=p.description,
                         category=p.category, created_at=p.created_at)


# ---- Permissions ----

@router.get("/permissions", response_model=PageResponse[PermissionOut])
async def list_permissions(
    page: int = Query(1, ge=1), size: int = Query(200, ge=1, le=500),
    category: str | None = None,
    db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user),
):
    q = select(Permission)
    if category:
        q = q.where(Permission.category == category)
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.order_by(Permission.permission_key).offset((page - 1) * size).limit(size))).scalars().all()
    return PageResponse(items=[_perm_out(p) for p in items], total=total, page=page, size=size)


# ---- Roles ----

@router.get("/roles", response_model=PageResponse[RoleOut])
async def list_roles(
    page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user),
):
    q = select(Role)
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.offset((page - 1) * size).limit(size))).scalars().all()
    return PageResponse(items=[_role_out(r) for r in items], total=total, page=page, size=size)


@router.post("/roles", response_model=RoleOut, status_code=201)
async def create_role(
    body: CreateRoleRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    existing = (await db.execute(select(Role).where(Role.role_key == body.role_key))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="role_key already exists")

    role = Role(role_key=body.role_key, name=body.name, description=body.description,
                role_scope=body.role_scope, metadata_=body.metadata or {},
                tags=body.tags or [], created_by=current_user.id)
    db.add(role)
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="role_created",
                       target_type="role", target_id=role.id, payload={"role_key": role.role_key})
    await db.commit()
    await db.refresh(role)
    return _role_out(role)


@router.get("/roles/{role_key}", response_model=RoleOut)
async def get_role(role_key: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    role = (await db.execute(select(Role).where(Role.role_key == role_key))).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    return _role_out(role)


@router.post("/roles/{role_key}/permissions", status_code=201)
async def add_permission_to_role(
    role_key: str, body: AssignPermissionRequest,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    role = (await db.execute(select(Role).where(Role.role_key == role_key))).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")

    perm = (await db.execute(select(Permission).where(Permission.permission_key == body.permission_key))).scalar_one_or_none()
    if not perm:
        raise HTTPException(status_code=404, detail=f"Permission '{body.permission_key}' not found")

    existing = (await db.execute(
        select(RolePermission).where(RolePermission.role_id == role.id, RolePermission.permission_id == perm.id)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Permission already assigned")

    rp = RolePermission(role_id=role.id, permission_id=perm.id)
    db.add(rp)
    await record_event(db, actor_user_id=current_user.id, event_type="permission_added_to_role",
                       target_type="role", target_id=str(role.id),
                       payload={"role_key": role_key, "permission_key": body.permission_key})
    await db.commit()
    return {"role_key": role_key, "permission_key": body.permission_key}


@router.delete("/roles/{role_key}/permissions/{permission_key}", status_code=204)
async def remove_permission_from_role(
    role_key: str, permission_key: str,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    role = (await db.execute(select(Role).where(Role.role_key == role_key))).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    perm = (await db.execute(select(Permission).where(Permission.permission_key == permission_key))).scalar_one_or_none()
    if not perm:
        raise HTTPException(status_code=404, detail="Permission not found")
    rp = (await db.execute(
        select(RolePermission).where(RolePermission.role_id == role.id, RolePermission.permission_id == perm.id)
    )).scalar_one_or_none()
    if rp:
        await db.delete(rp)
        await db.commit()
