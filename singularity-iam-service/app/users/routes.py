from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_
from app.database import get_db
from app.models import User, LocalCredential, PlatformRoleAssignment, Role
from app.auth.deps import require_reference_read, require_super_admin
from app.auth.password import hash_password
from app.schemas import PageResponse
from app.users.schemas import UserOut, CreateUserRequest, UpdateUserRequest, SetLocalPasswordRequest
from app.audit.service import record_event
from datetime import datetime, timezone
from pydantic import BaseModel


class AssignRoleRequest(BaseModel):
    role_key: str

router = APIRouter(prefix="/users", tags=["users"])


def _to_out(u: User) -> UserOut:
    return UserOut(
        id=u.id, email=u.email, display_name=u.display_name,
        status=u.status, auth_provider=u.auth_provider,
        external_subject=u.external_subject,
        is_super_admin=u.is_super_admin, is_local_account=u.is_local_account,
        metadata=u.metadata_ or {}, tags=u.tags or [],
        created_at=u.created_at, updated_at=u.updated_at,
    )


@router.get("", response_model=PageResponse[UserOut])
async def list_users(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=200),
    search: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_reference_read),
):
    q = select(User)
    if search:
        q = q.where(or_(User.email.ilike(f"%{search}%"), User.display_name.ilike(f"%{search}%")))
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    users = (await db.execute(q.offset((page - 1) * size).limit(size))).scalars().all()
    return PageResponse(items=[_to_out(u) for u in users], total=total, page=page, size=size)


@router.post("", response_model=UserOut, status_code=201)
async def create_user(
    body: CreateUserRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    existing = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Email already exists")

    user = User(
        email=body.email,
        display_name=body.display_name,
        auth_provider=body.auth_provider,
        external_subject=body.external_subject,
        metadata_=body.metadata or {},
        tags=body.tags or [],
    )
    db.add(user)
    await db.flush()
    await record_event(db, actor_user_id=current_user.id, event_type="user_created",
                       target_type="user", target_id=user.id, payload={"email": user.email})
    await db.commit()
    await db.refresh(user)
    return _to_out(user)


@router.get("/{user_id}", response_model=UserOut)
async def get_user(user_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(require_reference_read)):
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return _to_out(user)


@router.patch("/{user_id}", response_model=UserOut)
async def update_user(
    user_id: str,
    body: UpdateUserRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if body.display_name is not None:
        user.display_name = body.display_name
    if body.status is not None:
        user.status = body.status
    if body.is_super_admin is not None:
        user.is_super_admin = body.is_super_admin
    if body.metadata is not None:
        user.metadata_ = body.metadata
    if body.tags is not None:
        user.tags = body.tags
    user.updated_at = datetime.now(timezone.utc)

    await record_event(db, actor_user_id=current_user.id, event_type="user_updated",
                       target_type="user", target_id=user_id, payload=body.model_dump(exclude_none=True))
    await db.commit()
    await db.refresh(user)
    return _to_out(user)


@router.post("/{user_id}/password")
async def set_local_password(
    user_id: str,
    body: SetLocalPasswordRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Provision or rotate the password for an IAM local account.

    Passwords are accepted only for this one request, hashed with the same
    bcrypt helper used by local login, and never returned or written to audit
    payloads. Setting one deliberately converts the identity to a local
    account and removes any federated subject binding.
    """
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.status != "active":
        raise HTTPException(status_code=409, detail="Cannot set a password for an inactive user")

    credential = (await db.execute(select(LocalCredential).where(LocalCredential.user_id == user_id))).scalar_one_or_none()
    password_hash = hash_password(body.password)
    if credential:
        credential.password_hash = password_hash
        credential.password_changed_at = datetime.now(timezone.utc)
    else:
        db.add(LocalCredential(
            user_id=user_id,
            password_hash=password_hash,
            password_changed_at=datetime.now(timezone.utc),
        ))
    user.auth_provider = "local"
    user.external_subject = None
    user.is_local_account = True
    user.updated_at = datetime.now(timezone.utc)
    await record_event(
        db,
        actor_user_id=current_user.id,
        event_type="local_password_set",
        target_type="user",
        target_id=user_id,
        payload={"auth_provider": "local"},
    )
    await db.commit()
    return {"user_id": user_id, "auth_provider": "local", "is_local_account": True}


@router.get("/{user_id}/roles")
async def list_user_roles(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_reference_read),
):
    from app.roles.schemas import RoleOut
    rows = (await db.execute(
        select(PlatformRoleAssignment).where(PlatformRoleAssignment.user_id == user_id)
    )).scalars().all()
    roles = []
    for row in rows:
        role = (await db.execute(select(Role).where(Role.id == row.role_id))).scalar_one_or_none()
        if role:
            roles.append(role)
    from app.roles.routes import _role_out
    return [_role_out(r) for r in roles]


@router.post("/{user_id}/roles", status_code=201)
async def assign_role_to_user(
    user_id: str,
    body: AssignRoleRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    role = (await db.execute(select(Role).where(Role.role_key == body.role_key))).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{body.role_key}' not found")
    existing = (await db.execute(
        select(PlatformRoleAssignment).where(
            PlatformRoleAssignment.user_id == user_id,
            PlatformRoleAssignment.role_id == role.id,
        )
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Role already assigned")
    assignment = PlatformRoleAssignment(user_id=user_id, role_id=role.id, granted_by=current_user.id)
    db.add(assignment)
    await record_event(db, actor_user_id=current_user.id, event_type="platform_role_assigned",
                       target_type="user", target_id=user_id, payload={"role_key": body.role_key})
    await db.commit()
    return {"user_id": user_id, "role_key": body.role_key}


@router.delete("/{user_id}/roles/{role_key}", status_code=204)
async def remove_role_from_user(
    user_id: str,
    role_key: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    role = (await db.execute(select(Role).where(Role.role_key == role_key))).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    assignment = (await db.execute(
        select(PlatformRoleAssignment).where(
            PlatformRoleAssignment.user_id == user_id,
            PlatformRoleAssignment.role_id == role.id,
        )
    )).scalar_one_or_none()
    if not assignment:
        raise HTTPException(status_code=404, detail="Role not assigned to this user")
    await db.delete(assignment)
    await record_event(db, actor_user_id=current_user.id, event_type="platform_role_removed",
                       target_type="user", target_id=user_id, payload={"role_key": role_key})
    await db.commit()
