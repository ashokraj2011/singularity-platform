from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.database import get_db
from app.models import Role, Permission, RolePermission, User
from app.auth.deps import require_reference_read, require_super_admin
from app.schemas import PageResponse
from app.roles.schemas import (
    RoleOut, PermissionOut, CreateRoleRequest, AssignPermissionRequest,
    CreatePermissionRequest, UpdatePermissionRequest,
)
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
    db: AsyncSession = Depends(get_db), _: User = Depends(require_reference_read),
):
    q = select(Permission)
    if category:
        q = q.where(Permission.category == category)
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.order_by(Permission.permission_key).offset((page - 1) * size).limit(size))).scalars().all()
    return PageResponse(items=[_perm_out(p) for p in items], total=total, page=page, size=size)


@router.post("/permissions", response_model=PermissionOut, status_code=201)
async def create_permission(
    body: CreatePermissionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Register a new permission key in the catalog.

    Note: the catalog is the *vocabulary* of access; a newly-registered key does
    not gate anything until code or a governance policy checks it. What this does
    give you immediately is a key you can bundle into roles.
    """
    key = (body.permission_key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="permission_key is required")
    existing = (await db.execute(select(Permission).where(Permission.permission_key == key))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail=f"Permission '{key}' already exists")
    perm = Permission(
        permission_key=key,
        category=(body.category or None),
        description=(body.description or None),
    )
    db.add(perm)
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="permission_created",
                       target_type="permission", target_id=perm.id, payload={"permission_key": key})
    await db.commit()
    await db.refresh(perm)
    return _perm_out(perm)


@router.patch("/permissions/{permission_key}", response_model=PermissionOut)
async def update_permission(
    permission_key: str, body: UpdatePermissionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Edit a permission's human-facing metadata (category/description). The key
    itself is immutable — it is the anchor code/policies match on; to change a key,
    delete and recreate it (and update whatever checks it)."""
    perm = (await db.execute(select(Permission).where(Permission.permission_key == permission_key))).scalar_one_or_none()
    if not perm:
        raise HTTPException(status_code=404, detail="Permission not found")
    if body.category is not None:
        perm.category = body.category.strip() or None
    if body.description is not None:
        perm.description = body.description.strip() or None
    await record_event(db, actor_user_id=current_user.id, event_type="permission_updated",
                       target_type="permission", target_id=perm.id, payload={"permission_key": perm.permission_key})
    await db.commit()
    await db.refresh(perm)
    return _perm_out(perm)


@router.delete("/permissions/{permission_key}", status_code=204)
async def delete_permission(
    permission_key: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Delete a permission from the catalog.

    Blocked while the permission is still granted to any role: the FK would CASCADE
    and silently strip the grant from those roles (a surprise privilege change), so
    the operator must unbind it in the role editor first. Note: keys shipped in the
    default seed reappear on the next IAM restart."""
    perm = (await db.execute(select(Permission).where(Permission.permission_key == permission_key))).scalar_one_or_none()
    if not perm:
        raise HTTPException(status_code=404, detail="Permission not found")
    bound_roles = (await db.execute(
        select(Role.role_key)
        .join(RolePermission, RolePermission.role_id == Role.id)
        .where(RolePermission.permission_id == perm.id)
        .order_by(Role.role_key)
    )).scalars().all()
    if bound_roles:
        raise HTTPException(
            status_code=409,
            detail=f"Permission is granted to role(s): {', '.join(bound_roles)}. Remove it from those roles first.",
        )
    perm_id = perm.id
    await db.delete(perm)
    await record_event(db, actor_user_id=current_user.id, event_type="permission_deleted",
                       target_type="permission", target_id=perm_id, payload={"permission_key": permission_key})
    await db.commit()
    return None


# ---- Roles ----

@router.get("/roles", response_model=PageResponse[RoleOut])
async def list_roles(
    page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db), _: User = Depends(require_reference_read),
):
    q = select(Role)
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.offset((page - 1) * size).limit(size))).scalars().all()
    return PageResponse(items=[_role_out(r) for r in items], total=total, page=page, size=size)


@router.post("/roles", response_model=RoleOut, status_code=201)
async def create_role(
    body: CreateRoleRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
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
async def get_role(role_key: str, db: AsyncSession = Depends(get_db), _: User = Depends(require_reference_read)):
    role = (await db.execute(select(Role).where(Role.role_key == role_key))).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    return _role_out(role)


@router.get("/roles/{role_key}/permissions", response_model=list[PermissionOut])
async def list_role_permissions(
    role_key: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_reference_read),
):
    role = (await db.execute(select(Role).where(Role.role_key == role_key))).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    rows = (await db.execute(
        select(RolePermission).where(RolePermission.role_id == role.id)
    )).scalars().all()
    perms = []
    for row in rows:
        perm = (await db.execute(select(Permission).where(Permission.id == row.permission_id))).scalar_one_or_none()
        if perm:
            perms.append(_perm_out(perm))
    return perms


@router.post("/roles/{role_key}/permissions", status_code=201)
async def add_permission_to_role(
    role_key: str, body: AssignPermissionRequest,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(require_super_admin),
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
    db: AsyncSession = Depends(get_db), current_user: User = Depends(require_super_admin),
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
