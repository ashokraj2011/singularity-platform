"""Seed default permissions, roles, and super admin account on startup."""
import logging
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text
from app.models import Permission, Role, RolePermission, User, LocalCredential
from app.seed.default_permissions import DEFAULT_PERMISSIONS
from app.seed.default_roles import DEFAULT_ROLES
from app.auth.password import hash_password
from app.config import settings

log = logging.getLogger(__name__)


async def seed_all(db: AsyncSession) -> None:
    await _seed_permissions(db)
    await _seed_roles(db)
    await _seed_super_admin(db)
    await db.commit()
    log.info("Seed complete")


async def _seed_permissions(db: AsyncSession) -> None:
    for p in DEFAULT_PERMISSIONS:
        existing = (await db.execute(
            select(Permission).where(Permission.permission_key == p["permission_key"])
        )).scalar_one_or_none()
        if not existing:
            db.add(Permission(**p))
    await db.flush()


async def _seed_roles(db: AsyncSession) -> None:
    for r in DEFAULT_ROLES:
        perm_keys = r.pop("permissions", [])
        existing = (await db.execute(select(Role).where(Role.role_key == r["role_key"]))).scalar_one_or_none()
        if not existing:
            role = Role(**r)
            db.add(role)
            await db.flush()
            role_id = role.id
        else:
            role_id = existing.id

        for pkey in perm_keys:
            perm = (await db.execute(select(Permission).where(Permission.permission_key == pkey))).scalar_one_or_none()
            if perm:
                exists = (await db.execute(
                    select(RolePermission).where(
                        RolePermission.role_id == role_id, RolePermission.permission_id == perm.id
                    )
                )).scalar_one_or_none()
                if not exists:
                    db.add(RolePermission(role_id=role_id, permission_id=perm.id))
    await db.flush()


async def _seed_super_admin(db: AsyncSession) -> None:
    email = settings.LOCAL_SUPER_ADMIN_EMAIL
    existing = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if existing:
        return

    user = User(
        email=email,
        display_name="Super Admin",
        status="active",
        is_super_admin=True,
        is_local_account=True,
        auth_provider="local",
    )
    db.add(user)
    await db.flush()

    cred = LocalCredential(
        user_id=user.id,
        password_hash=hash_password(settings.LOCAL_SUPER_ADMIN_PASSWORD),
    )
    db.add(cred)
    await db.flush()
    log.info("Super admin created: %s", email)
