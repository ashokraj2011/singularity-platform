# IAM — `singularity_iam`

> **Hand-curated.** Source of truth: [`singularity-iam-service/app/models.py`](../../singularity-iam-service/app/models.py) (SQLAlchemy declarative). 20 tables. Edit this file when the SQLAlchemy models change.

Owner: `singularity-iam-service` (FastAPI · Python · SQLAlchemy 2.x · asyncpg).

IAM is the **identity + authorization source of truth**. Every other service either holds a UUID reference to an IAM row (via `capability_id`, `user_id`, `team_id`) or talks to IAM over HTTP. There is no FK enforcement between DBs.

## Core entities

```mermaid
erDiagram
  User {
    UUID id PK
    string email
    string display_name
    bool   is_super_admin
    UUID   primary_business_unit_id FK
    datetime created_at
  }
  LocalCredential {
    UUID    id PK
    UUID    user_id FK
    string  password_hash
    bool    mfa_enabled
    string  mfa_secret
  }
  BusinessUnit {
    UUID    id PK
    string  name
    UUID    parent_business_unit_id FK
    UUID    owner_user_id FK
  }
  Team {
    UUID    id PK
    string  name
    UUID    business_unit_id FK
    string  description
  }
  TeamMembership {
    UUID    id PK
    UUID    team_id FK
    UUID    user_id FK
    string  role
  }
  Capability {
    UUID    id PK
    string  capability_id "slug, e.g. default-demo"
    string  name
    string  capability_type
    UUID    owner_bu_id FK
    UUID    owner_team_id FK
    string  status
    string  visibility
    jsonb   metadata
  }
  CapabilityRelationship {
    UUID    id PK
    UUID    capability_id FK
    UUID    related_capability_id FK
    string  relationship_type
  }
  CapabilitySharingGrant {
    UUID    id PK
    UUID    capability_id FK
    UUID    target_team_id FK
    UUID    target_user_id FK
    string  permission
  }
  CapabilityMembership {
    UUID    id PK
    UUID    capability_id FK
    UUID    user_id FK
    UUID    team_id FK
    string  role
  }
  McpServer {
    UUID    id PK
    UUID    capability_id FK "scoped to one capability"
    string  name
    string  base_url
    string  auth_method "BEARER_TOKEN"
    string  bearer_token
    string  protocol    "MCP_HTTP | MCP_WS"
    string  status      "active | suspended"
  }
  UserDevice {
    UUID    id PK
    UUID    user_id FK
    string  device_id "stable per-laptop UUID"
    string  device_name
    string[] scopes
    datetime created_at
    datetime last_seen_at
    datetime revoked_at
  }
  AuditEvent {
    UUID    id PK
    UUID    actor_user_id FK
    string  event_type
    string  capability_id "slug, not UUID"
    string  target_type
    UUID    target_id
    jsonb   payload
    datetime occurred_at
  }

  User                ||--o{ LocalCredential        : has
  User                ||--o{ TeamMembership         : member_of
  Team                ||--o{ TeamMembership         : has
  Team                }o--|| BusinessUnit           : in
  BusinessUnit        ||--o{ Capability             : owns
  Team                ||--o{ Capability             : owns
  Capability          ||--o{ CapabilityRelationship : source
  Capability          ||--o{ CapabilitySharingGrant : shares
  Capability          ||--o{ CapabilityMembership   : has
  Capability          ||--o{ McpServer              : registers
  User                ||--o{ UserDevice             : owns
  User                ||--o{ AuditEvent             : actor
```

## Authorization (RBAC)

```mermaid
erDiagram
  Permission {
    UUID id PK
    string name "e.g. capability:read"
    string description
  }
  Role {
    UUID id PK
    string name "e.g. capability-admin"
    string description
    string scope_type "platform | bu | capability"
  }
  RolePermission {
    UUID id PK
    UUID role_id FK
    UUID permission_id FK
  }
  PlatformRoleAssignment {
    UUID id PK
    UUID user_id FK
    UUID role_id FK
    string scope_type "platform | bu | capability | team"
    UUID   scope_id   "FK depending on scope_type"
  }

  Role ||--o{ RolePermission         : grants
  Permission ||--o{ RolePermission   : in
  Role ||--o{ PlatformRoleAssignment : assigned_via
  User ||--o{ PlatformRoleAssignment : has
```

## Event outbox (IAM → audit-gov)

```mermaid
erDiagram
  EventOutbox {
    UUID    id PK
    string  event_type
    UUID    aggregate_id
    jsonb   payload
    datetime emitted_at
    string  status "pending | delivered | failed"
  }
  EventSubscription {
    UUID    id PK
    string  subscriber_name
    string[] event_types
    string  target_url
    bool    is_active
  }
  EventDelivery {
    UUID    id PK
    UUID    event_id FK
    UUID    subscription_id FK
    int     status_code
    datetime attempted_at
  }
  EventOutbox       ||--o{ EventDelivery : delivered_via
  EventSubscription ||--o{ EventDelivery : receives
```

## Cross-DB outbound references

| Column | Used by |
|---|---|
| `User.id`                | every service via JWT `sub` claim |
| `Capability.id`          | `singularity.Capability` (mirror), `singularity_composer.PromptAssembly.capabilityId`, `workgraph.capabilities` (cache), `audit_governance.audit_events.capability_id` |
| `Team.id`                | `workgraph.teams.externalIamTeamId` |
| `McpServer.id`           | `audit_governance.audit_events.payload.mcpServerId`, cf `/execute` response correlation |
| `Skill.id`               | `workgraph.skills.externalIamSkillId` |
| `UserDevice.id`          | M26 device-token JWT `device_id` claim; carried by laptop-mode mcp-server invokes |
