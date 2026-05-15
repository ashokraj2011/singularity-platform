# Tool Service — `singularity.tool.*`

> **Hand-curated.** Source of truth: [`agent-and-tools/packages/db/init.sql`](../../agent-and-tools/packages/db/init.sql) (raw DDL, schema `tool.*` inside the shared `singularity` DB). 8 tables. Edit this file when the DDL changes.

Owner: `agent-and-tools/apps/tool-service` (TypeScript · Express · `pg`).

The tool service registry shares the `singularity` Postgres with agent-runtime but lives in a separate **Postgres schema** (`tool.*` vs `public.*`). It's the tool catalog + execution + client-runner state.

## Registry + execution

```mermaid
erDiagram
  tools {
    UUID     id PK
    text     tool_name "globally unique"
    text     display_name
    text     description
    text     version
    text     risk_level "low | medium | high | critical"
    bool     requires_approval
    jsonb    input_schema
    jsonb    output_schema
    text     execution_target "LOCAL | SERVER"
    jsonb    runtime          "{execution_location, runtime_type, ...}"
    text[]   allowed_capabilities
    text[]   tags
    text     status "ACTIVE | DEPRECATED"
    datetime created_at
  }
  tool_executions {
    UUID     id PK
    UUID     tool_id FK
    text     trace_id
    text     actor_id
    text     capability_id
    jsonb    input_args
    jsonb    output
    bool     success
    text     error
    int      latency_ms
    text     execution_kind "server | client_local | mcp"
    datetime started_at
    datetime completed_at
  }
  tool_audit_events {
    UUID     id PK
    text     kind "tool.registered | tool.invoked | tool.deprecated"
    UUID     tool_id FK
    UUID     execution_id FK
    text     actor_id
    jsonb    payload
    datetime created_at
  }

  tools             ||--o{ tool_executions    : invoked_via
  tools             ||--o{ tool_audit_events  : trail
  tool_executions   ||--o| tool_audit_events  : trail
```

## Client runners (local-machine execution)

Used pre-M27 for client-local tool execution. Now mostly **superseded by mcp-server's local-tool registry** (which runs in-process on the laptop or VPC). Kept for legacy execution paths + audit history.

```mermaid
erDiagram
  client_runners {
    UUID     id PK
    UUID     user_id "owns this runner"
    text     runner_id "stable per-laptop UUID"
    text     name
    text     status "online | offline | revoked"
    datetime last_seen_at
    datetime created_at
  }
  client_execution_jobs {
    UUID     id PK
    UUID     runner_id FK
    UUID     tool_id FK
    text     trace_id
    text     status "queued | claimed | running | succeeded | failed"
    text     claim_token
    jsonb    input_args
    jsonb    output
    text     error
    datetime queued_at
    datetime claimed_at
    datetime completed_at
  }

  client_runners ||--o{ client_execution_jobs : runs
  tools          ||--o{ client_execution_jobs : invokes
```

## Event bus (tool-service → audit-gov + subscribers)

Same shape as the IAM and agent-runtime event-outbox tables. Tool-service publishes its own bus and the audit-gov subscriber drains it.

```mermaid
erDiagram
  event_outbox {
    UUID     id PK
    text     event_name
    text     source_service "tool-service"
    text     trace_id
    text     subject_kind
    text     subject_id
    jsonb    envelope
    text     status "pending | dispatched | failed"
    int      attempts
    datetime emitted_at
  }
  event_subscriptions {
    UUID     id PK
    text     subscriber_id
    text     event_pattern
    text     target_url
    text     secret
    bool     is_active
  }
  event_deliveries {
    UUID     id PK
    UUID     outbox_id FK
    UUID     subscription_id FK
    text     status   "queued | delivered | failed"
    int      attempts
    int      response_status
    datetime delivered_at
  }
  event_outbox        ||--o{ event_deliveries : delivered_via
  event_subscriptions ||--o{ event_deliveries : receives
```

## Cross-DB outbound references

| Column | Used by |
|---|---|
| `tools.id` | `singularity.ToolGrant.toolId` (agent-runtime's grants reference these), `workgraph.tools.externalToolId` (snapshot) |
| `tools.tool_name` | mcp-server invoke envelopes — the LLM picks tools by `tool_name`, not UUID |
| `tool_executions.trace_id` | joinable to `audit_governance.audit_events.trace_id` for full run reconstruction |
| `client_runners.user_id` | `singularity_iam.users.id` (the owning operator) |

## Why this lives inside `singularity` and not its own DB

The `tool.*` tables share a connection pool with agent-runtime's `public.*` tables. After M30 we split prompt-composer into its own DB but kept tool-service co-resident with agent-runtime because:
- agent-runtime's `ToolDefinition` model (in `public.ToolDefinition`) is the **typed catalog** used during prompt assembly; `tool.tools` is the **runtime + grants catalog** used during execution. They reference each other by `tool_name` (1:1).
- Splitting `tool.*` to its own DB would require either an HTTP refactor of every grant-resolution call site or a 2nd Prisma client — neither has a forcing function today.

If/when this changes (e.g. tool-service goes multi-tenant), the same `output = "../generated/..."` per-service-client pattern that prompt-composer uses today is the migration template.
