# Audit-Governance — `audit_governance`

> **Hand-curated.** Source of truth: [`audit-governance-service/db/init.sql`](../../audit-governance-service/db/init.sql) (raw DDL, schema `audit_governance.*`). 11 tables. Edit this file when the DDL changes.

Owner: `audit-governance-service` (TypeScript · Express · `pg`). Receives **fire-and-forget audit events** from every other service, plus serves **synchronous pre-flight checks** (budget, rate-limit, governance policy) for the `governanceMode=fail_closed` path.

This is the **only DB you can SQL-join across all platform activity** — every event carries `trace_id`, `capability_id`, `actor_id`, `subject_id` from upstream producers.

## Event spine

```mermaid
erDiagram
  audit_events {
    UUID    id PK
    text    trace_id  "M28 spine-2 — joinable to mcp + composer + cf"
    text    source_service "mcp-server | context-fabric | prompt-composer | workgraph-api | agent-runtime | iam"
    text    kind     "e.g. llm.call.completed, governance.precheck.denied"
    text    subject_type
    text    subject_id
    text    actor_id "user_id (UUID) or service:<name>"
    text    capability_id
    text    tenant_id
    text    severity "info | warn | error"
    jsonb   payload
    datetime created_at
  }
  llm_calls {
    UUID    id PK
    UUID    audit_event_id FK
    text    provider "openai | anthropic | copilot | mock"
    text    model
    int     input_tokens
    int     output_tokens
    int     total_tokens
    numeric cost_estimate "USD"
    int     latency_ms
    text    finish_reason
    datetime created_at
  }
  authz_decisions {
    UUID    id PK
    UUID    audit_event_id FK
    text    actor_id
    text    capability_id
    text    action
    text    resource_type
    text    resource_id
    bool    allowed
    text    reason
    text[]  roles
    text[]  permissions
    text    source "iam | pseudo-iam | cached"
    datetime created_at
  }

  audit_events ||--o| llm_calls       : details
  audit_events ||--o| authz_decisions : details
```

`audit_events` is the parent for typed sub-records. `llm_calls` + `authz_decisions` link 1:1 to their parent via `audit_event_id`. Most audit events have NO sub-record (they're just `kind` + `payload`).

## Governance pre-flight tables

These are read synchronously during cf `/execute` and mcp-server loop iterations to decide budget + rate + approval gates.

```mermaid
erDiagram
  rate_card {
    UUID    id PK
    text    provider
    text    model
    numeric input_per_1k    "USD per 1k input tokens"
    numeric output_per_1k   "USD per 1k output tokens"
    datetime effective_at
    bool    is_current
  }
  budgets {
    UUID    id PK
    text    scope_type    "capability | team | tenant | global"
    text    scope_id
    text    period        "daily | monthly | run"
    numeric usd_limit
    numeric usd_consumed
    datetime period_start
    datetime period_end
  }
  rate_limits {
    UUID    id PK
    text    scope_type "capability | actor | tenant"
    text    scope_id
    int     window_sec
    int     max_calls
    int     calls_in_window
    datetime window_start
  }
  approvals {
    UUID    id PK
    text    trace_id
    text    requester_actor_id
    text    capability_id
    text    tool_name
    jsonb   tool_args
    text    risk_level "LOW | MEDIUM | HIGH | CRITICAL"
    text    status     "pending | approved | denied | expired"
    text    decided_by
    text    decision_reason
    datetime requested_at
    datetime decided_at
  }
```

`rate_card` is the cost catalog (one row per provider+model+effective-window; LLM calls in `llm_calls` get `cost_estimate` = `tokens × rate`). `budgets` and `rate_limits` are mutated atomically on every `/execute` pre-flight. `approvals` is the governance side of the workgraph approval queue — workgraph keeps its own approval table for the in-flight workflow state.

## Engine (Singularity Engine M-something — automated failure triage)

```mermaid
erDiagram
  engine_issues {
    UUID    id PK
    text    issue_kind
    text    trace_id
    text    capability_id
    text    severity
    text    summary
    jsonb   evidence
    text    status "open | acknowledged | resolved | wontfix"
    datetime detected_at
    datetime resolved_at
  }
  engine_evaluators {
    UUID    id PK
    text    name
    text    description
    text    sql_expression
    text    target_kind
    bool    is_active
  }
  engine_datasets {
    UUID    id PK
    text    name
    text    description
  }
  engine_dataset_examples {
    UUID    id PK
    UUID    dataset_id FK
    text    input
    text    expected_output
    jsonb   metadata
  }
  engine_datasets ||--o{ engine_dataset_examples : contains
```

Used by the Singularity Engine to triage recurring failure patterns in the audit ledger. Out of scope for most readers.

## Inbound references (who writes what)

| Producer service | Writes to | Trigger |
|---|---|---|
| `mcp-server` | `audit_events`, `llm_calls` | every LLM call, every tool invocation, every approval pause, every code-change commit |
| `context-fabric` | `audit_events` (incl. `governance.precheck.*`), `authz_decisions` | `/execute` orchestration |
| `prompt-composer` | `audit_events` (`prompt.assembly.created`, `compose.capsule.compile.alert`) | every compose call |
| `agent-runtime` | `audit_events` (`agent.template.derived`, `tool.grant.created`) | template + grant CRUD |
| `workgraph-api` | `audit_events` (workflow/run/task lifecycle), `approvals` (when governance gate fires) | DAG executor + approval-router |
| `singularity-iam-service` | `audit_events` (`iam.authz.decision`, `device.token.minted`, `device.revoked`), `authz_decisions` | auth + authz endpoints |

## Outbound references

| Column | Read by |
|---|---|
| `audit_events.trace_id` | Workgraph Run Insights timeline, `bin/test-trace-spine.sh`, mcp-server `/mcp/resources/*?trace_id=…` |
| `audit_events.capability_id` | governance pre-flights, Run Insights filtering |
| `llm_calls.cost_estimate` | `budgets.usd_consumed` updates, metrics-ledger dashboards |
| `approvals.id` | workgraph approval-router cross-reference |
