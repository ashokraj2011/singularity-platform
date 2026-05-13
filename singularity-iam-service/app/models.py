import uuid
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import (
    String, Boolean, ForeignKey, UniqueConstraint,
    CheckConstraint, Index, text,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy import TIMESTAMP as _TIMESTAMP

def _tstz():
    return _TIMESTAMP(timezone=True)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        Index("idx_users_email", "email"),
        Index("idx_users_external_subject", "auth_provider", "external_subject"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    display_name: Mapped[Optional[str]] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, nullable=False, server_default="active")
    auth_provider: Mapped[Optional[str]] = mapped_column(String)
    external_subject: Mapped[Optional[str]] = mapped_column(String)
    is_super_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    is_local_account: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now, onupdate=_now)

    local_credential: Mapped[Optional["LocalCredential"]] = relationship(back_populates="user", uselist=False)
    platform_roles: Mapped[list["PlatformRoleAssignment"]] = relationship(
        back_populates="user", foreign_keys="[PlatformRoleAssignment.user_id]"
    )
    capability_memberships: Mapped[list["CapabilityMembership"]] = relationship(
        back_populates="user", foreign_keys="CapabilityMembership.user_id"
    )


class LocalCredential(Base):
    __tablename__ = "local_credentials"
    __table_args__ = {"schema": "iam"}

    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("iam.users.id", ondelete="CASCADE"), primary_key=True
    )
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    mfa_secret_ref: Mapped[Optional[str]] = mapped_column(String)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(_tstz())
    password_changed_at: Mapped[Optional[datetime]] = mapped_column(_tstz())
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)

    user: Mapped["User"] = relationship(back_populates="local_credential")


# ---------------------------------------------------------------------------
# Business Units & Teams
# ---------------------------------------------------------------------------

class BusinessUnit(Base):
    __tablename__ = "business_units"
    __table_args__ = {"schema": "iam"}

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    bu_key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String)
    parent_bu_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False), ForeignKey("iam.business_units.id"), nullable=True
    )
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now, onupdate=_now)


class Team(Base):
    __tablename__ = "teams"
    __table_args__ = {"schema": "iam"}

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    team_key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String)
    bu_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.business_units.id"))
    parent_team_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.teams.id"), nullable=True)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now, onupdate=_now)

    members: Mapped[list["TeamMembership"]] = relationship(back_populates="team")


class TeamMembership(Base):
    __tablename__ = "team_memberships"
    __table_args__ = (
        UniqueConstraint("team_id", "user_id"),
        Index("idx_team_memberships_user", "user_id"),
        Index("idx_team_memberships_team", "team_id"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    team_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("iam.teams.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("iam.users.id", ondelete="CASCADE"), nullable=False
    )
    membership_type: Mapped[str] = mapped_column(String, server_default="member")
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)

    team: Mapped["Team"] = relationship(back_populates="members")
    user: Mapped["User"] = relationship()


# ---------------------------------------------------------------------------
# Capabilities
# ---------------------------------------------------------------------------

class Capability(Base):
    __tablename__ = "capabilities"
    __table_args__ = (
        Index("idx_capabilities_type", "capability_type"),
        Index("idx_capabilities_status", "status"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    capability_id: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String)
    capability_type: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, server_default="active")
    visibility: Mapped[str] = mapped_column(String, nullable=False, server_default="private")
    owner_bu_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.business_units.id"))
    owner_team_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.teams.id"))
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    created_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.users.id"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now, onupdate=_now)


class CapabilityRelationship(Base):
    __tablename__ = "capability_relationships"
    __table_args__ = (
        UniqueConstraint("source_capability_id", "target_capability_id", "relationship_type"),
        Index("idx_cap_rel_source", "source_capability_id"),
        Index("idx_cap_rel_target", "target_capability_id"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    source_capability_id: Mapped[str] = mapped_column(
        String, ForeignKey("iam.capabilities.capability_id"), nullable=False
    )
    target_capability_id: Mapped[str] = mapped_column(
        String, ForeignKey("iam.capabilities.capability_id"), nullable=False
    )
    relationship_type: Mapped[str] = mapped_column(String, nullable=False)
    inheritance_policy: Mapped[str] = mapped_column(String, nullable=False, server_default="none")
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    created_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.users.id"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)


class CapabilitySharingGrant(Base):
    __tablename__ = "capability_sharing_grants"
    __table_args__ = (
        UniqueConstraint("provider_capability_id", "consumer_capability_id", "grant_type"),
        Index("idx_sharing_provider", "provider_capability_id"),
        Index("idx_sharing_consumer", "consumer_capability_id"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    provider_capability_id: Mapped[str] = mapped_column(
        String, ForeignKey("iam.capabilities.capability_id"), nullable=False
    )
    consumer_capability_id: Mapped[str] = mapped_column(
        String, ForeignKey("iam.capabilities.capability_id"), nullable=False
    )
    grant_type: Mapped[str] = mapped_column(String, nullable=False)
    allowed_permissions: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    status: Mapped[str] = mapped_column(String, nullable=False, server_default="active")
    approved_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.users.id"))
    approved_at: Mapped[Optional[datetime]] = mapped_column(_tstz())
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)


class CapabilityMembership(Base):
    __tablename__ = "capability_memberships"
    __table_args__ = (
        CheckConstraint("user_id IS NOT NULL OR team_id IS NOT NULL", name="chk_member_or_team"),
        Index("idx_cap_membership_user", "user_id"),
        Index("idx_cap_membership_team", "team_id"),
        Index("idx_cap_membership_cap", "capability_id"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    capability_id: Mapped[str] = mapped_column(
        String, ForeignKey("iam.capabilities.capability_id"), nullable=False
    )
    user_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.users.id"))
    team_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.teams.id"))
    role_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.roles.id"), nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, server_default="active")
    granted_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.users.id"))
    valid_from: Mapped[Optional[datetime]] = mapped_column(_tstz(), default=_now)
    valid_until: Mapped[Optional[datetime]] = mapped_column(_tstz())
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)

    user: Mapped[Optional["User"]] = relationship(
        back_populates="capability_memberships", foreign_keys=[user_id]
    )
    role: Mapped["Role"] = relationship()


# ---------------------------------------------------------------------------
# Roles & Permissions
# ---------------------------------------------------------------------------

class Permission(Base):
    __tablename__ = "permissions"
    __table_args__ = {"schema": "iam"}

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    permission_key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String)
    category: Mapped[Optional[str]] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)


class Role(Base):
    __tablename__ = "roles"
    __table_args__ = {"schema": "iam"}

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    role_key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String)
    role_scope: Mapped[str] = mapped_column(String, nullable=False)
    system_role: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    created_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.users.id"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now, onupdate=_now)

    role_permissions: Mapped[list["RolePermission"]] = relationship(back_populates="role")


class RolePermission(Base):
    __tablename__ = "role_permissions"
    __table_args__ = (
        UniqueConstraint("role_id", "permission_id"),
        Index("idx_role_permissions_role", "role_id"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    role_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("iam.roles.id", ondelete="CASCADE"), nullable=False
    )
    permission_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("iam.permissions.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)

    role: Mapped["Role"] = relationship(back_populates="role_permissions")
    permission: Mapped["Permission"] = relationship()


class PlatformRoleAssignment(Base):
    __tablename__ = "platform_role_assignments"
    __table_args__ = (
        UniqueConstraint("user_id", "role_id"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("iam.users.id", ondelete="CASCADE"), nullable=False
    )
    role_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("iam.roles.id", ondelete="CASCADE"), nullable=False
    )
    granted_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.users.id"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)

    user: Mapped["User"] = relationship(back_populates="platform_roles", foreign_keys=[user_id])
    role: Mapped["Role"] = relationship()


# ---------------------------------------------------------------------------
# Audit Events
# ---------------------------------------------------------------------------

class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("idx_audit_actor", "actor_user_id"),
        Index("idx_audit_capability", "capability_id"),
        Index("idx_audit_event_type", "event_type"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    actor_user_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.users.id"))
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    capability_id: Mapped[Optional[str]] = mapped_column(String)
    target_type: Mapped[Optional[str]] = mapped_column(String)
    target_id: Mapped[Optional[str]] = mapped_column(String)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    ip_address: Mapped[Optional[str]] = mapped_column(String)
    user_agent: Mapped[Optional[str]] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)


# ---------------------------------------------------------------------------
# MCP Servers (M6 — per-capability registry of customer-deployed MCP servers)
#
# A customer registers one or more MCP servers per capability. context-fabric
# reads from this table to resolve which MCP server to call for an agent run.
# Customer-managed secrets (provider API keys, GitHub tokens, etc.) live on
# the MCP server itself — they NEVER appear here. The only secret stored
# here is the bearer token context-fabric uses to authenticate to the MCP.
#
# v0: bearer_token stored as plaintext (dev). Production must encrypt at
# rest (KMS/Vault) — see the column note.
# ---------------------------------------------------------------------------

class McpServer(Base):
    __tablename__ = "mcp_servers"
    __table_args__ = (
        Index("idx_mcp_servers_capability", "capability_id"),
        Index("idx_mcp_servers_status", "status"),
        UniqueConstraint("capability_id", "name", name="uq_mcp_servers_capability_name"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    capability_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("iam.capabilities.id"), nullable=False,
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String)
    base_url: Mapped[str] = mapped_column(String, nullable=False)
    auth_method: Mapped[str] = mapped_column(String, nullable=False, server_default="BEARER_TOKEN")
    # TODO(v1): encrypt at rest via KMS/Vault. Stored plaintext for v0 dev only.
    bearer_token: Mapped[str] = mapped_column(String, nullable=False)
    protocol: Mapped[str] = mapped_column(String, nullable=False, server_default="MCP_HTTP")
    protocol_version: Mapped[Optional[str]] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, nullable=False, server_default="active")
    last_health_check_at: Mapped[Optional[datetime]] = mapped_column(_tstz())
    last_health_check_status: Mapped[Optional[str]] = mapped_column(String)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    created_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.users.id"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now, onupdate=_now)


# ---------------------------------------------------------------------------
# Skills catalog
# ---------------------------------------------------------------------------
# Owned by IAM (so the assignment-routing SKILL_BASED mode resolves against
# a single source of truth across services). Minimal v0: catalog only.
# UserSkill / AgentSkill linking can land later.

class Skill(Base):
    __tablename__ = "skills"
    __table_args__ = (
        UniqueConstraint("skill_key", name="uq_skills_key"),
        Index("idx_skills_category", "category"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    skill_key: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String)
    category: Mapped[Optional[str]] = mapped_column(String)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    created_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.users.id"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now, onupdate=_now)


# ---------------------------------------------------------------------------
# M26 — User devices (laptop-resident mcp-server)
# ---------------------------------------------------------------------------
# One row per (user, laptop). The `singularity-mcp` CLI mints a device JWT
# via `POST /api/v1/auth/device-token`, stores it in the OS keychain, and
# uses it on every reconnect to context-fabric's laptop-bridge WS. Revoking
# a row (DELETE /api/v1/devices/:id sets revoked_at) makes the bridge drop
# the matching live connection on the next 60s sweep.

class UserDevice(Base):
    __tablename__ = "user_devices"
    __table_args__ = (
        UniqueConstraint("user_id", "device_id", name="uq_user_devices_user_device"),
        Index("idx_user_devices_user", "user_id"),
        Index("idx_user_devices_revoked", "revoked_at"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("iam.users.id", ondelete="CASCADE"), nullable=False,
    )
    # Client-generated UUID (kept stable across keychain rotations on the
    # same laptop). Plan P5: don't trust MAC / hostname.
    device_id: Mapped[str] = mapped_column(String, nullable=False)
    device_name: Mapped[Optional[str]] = mapped_column(String)
    scopes: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)
    # Bridge updates this on every heartbeat so operators can see how long
    # the laptop has been quiet. Not used for revocation by itself.
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(_tstz())
    revoked_at: Mapped[Optional[datetime]] = mapped_column(_tstz())


# ---------------------------------------------------------------------------
# M11.e — Event Bus
# ---------------------------------------------------------------------------
# Mirror of the workgraph-side schema so subscribers see the same canonical
# envelope across services. Postgres LISTEN/NOTIFY drives the dispatcher.

class EventOutbox(Base):
    __tablename__ = "event_outbox"
    __table_args__ = (
        Index("idx_event_outbox_status_emitted", "status", "emitted_at"),
        Index("idx_event_outbox_event_name", "event_name"),
        Index("idx_event_outbox_trace", "trace_id"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    event_name: Mapped[str] = mapped_column(String, nullable=False)
    source_service: Mapped[str] = mapped_column(String, nullable=False)
    trace_id: Mapped[Optional[str]] = mapped_column(String)
    subject_kind: Mapped[str] = mapped_column(String, nullable=False)
    subject_id: Mapped[str] = mapped_column(String, nullable=False)
    envelope: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, server_default="pending")
    attempts: Mapped[int] = mapped_column(default=0)
    emitted_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)
    last_attempt_at: Mapped[Optional[datetime]] = mapped_column(_tstz())
    last_error: Mapped[Optional[str]] = mapped_column(String)


class EventSubscription(Base):
    __tablename__ = "event_subscriptions"
    __table_args__ = (
        Index("idx_event_subscriptions_active", "is_active", "event_pattern"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    subscriber_id: Mapped[str] = mapped_column(String, nullable=False)
    event_pattern: Mapped[str] = mapped_column(String, nullable=False)
    target_url: Mapped[str] = mapped_column(String, nullable=False)
    secret: Mapped[Optional[str]] = mapped_column(String)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    created_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.users.id"))
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now, onupdate=_now)


class EventDelivery(Base):
    __tablename__ = "event_deliveries"
    __table_args__ = (
        UniqueConstraint("outbox_id", "subscription_id", name="uq_event_deliveries_outbox_sub"),
        Index("idx_event_deliveries_status", "status", "created_at"),
        {"schema": "iam"},
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    outbox_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.event_outbox.id", ondelete="CASCADE"), nullable=False)
    subscription_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("iam.event_subscriptions.id", ondelete="CASCADE"), nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, server_default="queued")
    attempts: Mapped[int] = mapped_column(default=0)
    last_attempt_at: Mapped[Optional[datetime]] = mapped_column(_tstz())
    last_error: Mapped[Optional[str]] = mapped_column(String)
    delivered_at: Mapped[Optional[datetime]] = mapped_column(_tstz())
    response_status: Mapped[Optional[int]] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)
