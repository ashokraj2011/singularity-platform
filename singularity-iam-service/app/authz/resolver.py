"""
Authorization resolver implementing the algorithm from the spec:
  1. Super admin bypass
  2. Platform permission (platform:all or exact match)
  3. Direct capability membership
  4. Team capability membership
  5. Inherited via capability relationship
  6. Shared capability grant
"""
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.models import (
    User, PlatformRoleAssignment, RolePermission, Permission,
    CapabilityMembership, TeamMembership, CapabilityRelationship,
    CapabilitySharingGrant, Role,
)


async def _get_permissions_for_role(db: AsyncSession, role_id: str) -> set[str]:
    result = await db.execute(
        select(Permission.permission_key)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .where(RolePermission.role_id == role_id)
    )
    return set(result.scalars().all())


async def _get_platform_permissions(db: AsyncSession, user_id: str) -> set[str]:
    result = await db.execute(
        select(PlatformRoleAssignment).where(PlatformRoleAssignment.user_id == user_id)
        .options(selectinload(PlatformRoleAssignment.role).selectinload(Role.role_permissions).selectinload(RolePermission.permission))
    )
    assignments = result.scalars().all()
    perms: set[str] = set()
    for assignment in assignments:
        for rp in assignment.role.role_permissions:
            perms.add(rp.permission.permission_key)
    return perms


async def _get_direct_capability_permissions(
    db: AsyncSession, user_id: str, capability_id: str
) -> tuple[set[str], list[str]]:
    result = await db.execute(
        select(CapabilityMembership)
        .where(
            CapabilityMembership.user_id == user_id,
            CapabilityMembership.capability_id == capability_id,
            CapabilityMembership.status == "active",
        )
        .options(selectinload(CapabilityMembership.role).selectinload(Role.role_permissions).selectinload(RolePermission.permission))
    )
    memberships = result.scalars().all()
    perms: set[str] = set()
    roles: list[str] = []
    for m in memberships:
        roles.append(m.role.role_key)
        for rp in m.role.role_permissions:
            perms.add(rp.permission.permission_key)
    return perms, roles


async def _get_team_capability_permissions(
    db: AsyncSession, user_id: str, capability_id: str
) -> tuple[set[str], list[str]]:
    team_ids_result = await db.execute(
        select(TeamMembership.team_id).where(TeamMembership.user_id == user_id)
    )
    team_ids = list(team_ids_result.scalars().all())
    if not team_ids:
        return set(), []

    result = await db.execute(
        select(CapabilityMembership)
        .where(
            CapabilityMembership.team_id.in_(team_ids),
            CapabilityMembership.capability_id == capability_id,
            CapabilityMembership.status == "active",
        )
        .options(selectinload(CapabilityMembership.role).selectinload(Role.role_permissions).selectinload(RolePermission.permission))
    )
    memberships = result.scalars().all()
    perms: set[str] = set()
    roles: list[str] = []
    for m in memberships:
        roles.append(m.role.role_key)
        for rp in m.role.role_permissions:
            perms.add(rp.permission.permission_key)
    return perms, roles


async def _get_inherited_permissions(
    db: AsyncSession, user_id: str, capability_id: str
) -> set[str]:
    # Find parent capabilities with inherit_* policies pointing to this capability
    result = await db.execute(
        select(CapabilityRelationship).where(
            CapabilityRelationship.target_capability_id == capability_id,
            CapabilityRelationship.inheritance_policy.in_(
                ["inherit_view", "inherit_execute", "inherit_admin"]
            ),
        )
    )
    rels = result.scalars().all()

    inherited: set[str] = set()
    for rel in rels:
        parent_perms, _ = await _get_direct_capability_permissions(db, user_id, rel.source_capability_id)
        policy = rel.inheritance_policy

        if policy == "inherit_view":
            inherited |= {p for p in parent_perms if ":view" in p or ":read" in p}
        elif policy == "inherit_execute":
            inherited |= {p for p in parent_perms if ":view" in p or ":execute" in p or ":run" in p}
        elif policy == "inherit_admin":
            inherited |= parent_perms

    return inherited


async def _check_shared_capability_access(
    db: AsyncSession,
    user_id: str,
    provider_capability_id: str,
    consumer_capability_id: str,
    action: str,
) -> bool:
    consumer_perms, _ = await _get_direct_capability_permissions(db, user_id, consumer_capability_id)
    team_perms, _ = await _get_team_capability_permissions(db, user_id, consumer_capability_id)
    all_consumer_perms = consumer_perms | team_perms

    if "capability:use_shared" not in all_consumer_perms:
        return False

    grant = (await db.execute(
        select(CapabilitySharingGrant).where(
            CapabilitySharingGrant.provider_capability_id == provider_capability_id,
            CapabilitySharingGrant.consumer_capability_id == consumer_capability_id,
            CapabilitySharingGrant.status == "active",
        )
    )).scalar_one_or_none()

    if not grant:
        return False

    return action in (grant.allowed_permissions or [])


class AuthzResult:
    def __init__(self, allowed: bool, reason: str, roles: list[str] = None,  # type: ignore[assignment]
                 permissions: list[str] = None, source: str = ""):  # type: ignore[assignment]
        self.allowed = allowed
        self.reason = reason
        self.roles = roles or []
        self.permissions = permissions or []
        self.source = source


async def check_authorization(
    db: AsyncSession,
    user_id: str,
    capability_id: str,
    action: str,
    requesting_capability_id: Optional[str] = None,
) -> AuthzResult:
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        return AuthzResult(False, "User not found")

    # 1. Super admin bypass
    if user.is_super_admin:
        return AuthzResult(True, "Super admin", permissions=[action], source="super_admin")

    # 2. Platform permissions
    platform_perms = await _get_platform_permissions(db, user_id)
    if "platform:all" in platform_perms or action in platform_perms:
        return AuthzResult(True, "Platform permission", permissions=list(platform_perms), source="platform_role")

    # 3. Direct capability membership
    direct_perms, direct_roles = await _get_direct_capability_permissions(db, user_id, capability_id)
    if action in direct_perms:
        return AuthzResult(True, f"User has {', '.join(direct_roles)} role in {capability_id}.",
                           roles=direct_roles, permissions=list(direct_perms), source="direct_capability_membership")

    # 4. Team capability membership
    team_perms, team_roles = await _get_team_capability_permissions(db, user_id, capability_id)
    if action in team_perms:
        return AuthzResult(True, f"Team membership grants access to {capability_id}.",
                           roles=team_roles, permissions=list(team_perms), source="team_capability_membership")

    # 5. Inherited permissions
    inherited = await _get_inherited_permissions(db, user_id, capability_id)
    if action in inherited:
        return AuthzResult(True, "Capability relationship inheritance.",
                           permissions=list(inherited), source="capability_relationship_inheritance")

    # 6. Shared capability access
    if requesting_capability_id:
        shared_ok = await _check_shared_capability_access(
            db, user_id, capability_id, requesting_capability_id, action
        )
        if shared_ok:
            return AuthzResult(
                True,
                f"User has access through {requesting_capability_id} and active sharing grant allows {action}.",
                permissions=[action], source="capability_sharing_grant",
            )

    return AuthzResult(False, "Missing permission")
