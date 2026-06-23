# Singularity Platform Handbook

Last verified from the local repository layout on 2026-06-19.

This handbook documents the Singularity platform as a whole: capabilities, components, service connections, features, installation, configuration, operations, and common extension paths. It is intended for engineers, operators, and product owners who need a single detailed map of how the system works.

## Contents

- [1. Executive Summary](#1-executive-summary)
- [2. Core Concepts](#2-core-concepts)
- [3. High-Level Architecture](#3-high-level-architecture)
- [4. Runtime Rule: Who Talks To The LLM](#4-runtime-rule-who-talks-to-the-llm)
- [5. Service Inventory](#5-service-inventory)
- [6. Repository Layout](#6-repository-layout)
- [7. Major Capabilities And Features](#7-major-capabilities-and-features)
- [8. WorkItem Metadata And Routing Model](#8-workitem-metadata-and-routing-model)
- [9. Important API Surfaces](#9-important-api-surfaces)
- [10. Installation](#10-installation)
- [11. Configuration](#11-configuration)
- [12. Operations](#12-operations)
- [13. Common Runtime Flows](#13-common-runtime-flows)
- [14. Governance And Security](#14-governance-and-security)
- [15. Observability](#15-observability)
- [16. Developer Extension Guide](#16-developer-extension-guide)
- [17. Troubleshooting](#17-troubleshooting)
- [18. Release Checklist](#18-release-checklist)
- [19. Existing Detailed References](#19-existing-detailed-references)

## 1. Executive Summary

Singularity is a governed enterprise agent platform. It brings together identity, capabilities, WorkItems, workflow orchestration, agent templates, prompt composition, context optimization, runtime tool execution, sandboxed command execution, audit governance, cost tracking, formal verification, and optional laptop-driven Copilot execution.

The central design rule is:

```text
Business work starts as a WorkItem.
Workflow runs are execution attempts attached to that WorkItem.
Agentic work goes through Context Fabric and Agent Execution Runtime.
The Agent Execution Runtime is the controlled runtime boundary for LLM and tool execution.
Audit and receipts make the whole path observable.
```

The platform supports two execution modes:

- **Server runtime mode**: Workgraph sends agent work to Context Fabric, Context Fabric invokes Agent Execution Runtime, Agent Execution Runtime calls the LLM Gateway and tools.
- **Laptop Copilot mode**: a local CLI or desktop app runs Copilot directly, while Singularity records events, questions, token usage, audit receipts, and WorkItem status.

## 2. Core Concepts

| Concept | Meaning |
|---|---|
| Capability | A business or technical domain that owns agents, workflows, WorkItems, policies, and memberships. |
| WorkItem | The first-class unit of business work. WorkItems can be created manually, from events, from schedules, or by parent workflows. |
| WorkItem Type | Metadata that describes what a WorkItem means, what fields it needs, how it routes, and which workflows can handle it. Examples: `BUG_FIX`, `FEATURE`, `INCIDENT`, `RESEARCH`, `GENERAL`. |
| Workflow Template | A reusable process definition made of nodes, edges, routing rules, and runtime policy. |
| Workflow Type | Metadata that describes what class of workflow this is and which WorkItem types it can handle. |
| Workflow Instance | One running execution of a workflow template. |
| Node Type | Runtime executor base plus metadata describing UI, config schema, validation, inputs, outputs, and edge rules. |
| Agent Template | A role-specific prompt, model, governance, and tool policy definition. |
| Prompt Composer | The service that owns prompt profiles, prompt layers, stage prompts, prompt assemblies, and reusable lessons. |
| Context Fabric | The orchestration layer for context assembly, optimized context packages, agent execution calls, receipts, and trace continuity. |
| Agent Execution Runtime | The local/server runtime surface for tools, code intelligence, editing, verification, discovery, session tokens, and LLM invocation. |
| LLM Gateway | Provider abstraction and model alias gateway. In the server runtime path, Agent Execution Runtime calls this gateway. |
| Audit Governance | Cross-service audit, receipts, budgets, rate limits, governance decisions, and cost evidence. |
| Code Context Budgeter | AST-first context selector that builds compact code-context packages for developer agents. |

## 3. High-Level Architecture

```mermaid
flowchart LR
  User["User / Operator"] --> Web["Platform Web"]
  Web --> IAM["IAM Service"]
  Web --> WGAPI["Workgraph API"]
  Web --> AgentRuntime["Agent Runtime"]
  Web --> ToolService["Tool Service"]
  Web --> PromptComposer["Prompt Composer"]
  Web --> ContextAPI["Context Fabric API"]

  WGAPI --> ContextAPI["Context Fabric API"]
  ContextAPI --> PromptComposer
  ContextAPI --> AER["Agent Execution Runtime / Server Runtime"]
  ContextAPI --> ContextMemory["Context Memory"]

  AER --> LLMGateway["LLM Gateway"]
  AER --> Runner["Runtime Sandbox Runner"]
  AER --> ToolService
  AER --> FormalVerifier["Formal Verifier"]

  WGAPI --> MinIO["MinIO Artifacts"]
  WGAPI --> WGDB["Workgraph Postgres"]
  IAM --> IAMDB["IAM Postgres"]
  AgentRuntime --> ATDB["Agent Runtime Postgres"]
  ToolService --> ATDB
  PromptComposer --> ATDB
  ContextAPI --> CFDB["Context Fabric Stores"]

  WGAPI --> AuditGov["Audit Governance"]
  ContextAPI --> AuditGov
  AER --> AuditGov
  ToolService --> AuditGov
  AgentRuntime --> AuditGov
  AuditGov --> AuditDB["Audit Postgres"]
  AuditGov --> Metrics["Metrics Ledger"]

  Laptop["sgl CLI / Desktop Copilot"] --> WGAPI
  Laptop --> AuditGov
  Laptop --> AER
```

## 4. Runtime Rule: Who Talks To The LLM

For server-side agentic execution, Singularity should preserve this rule:

```text
Workbench / Workgraph -> Context Fabric -> Agent Execution Runtime -> LLM Gateway -> Provider
```

Other services can request execution, assemble context, route WorkItems, and record audit events, but they should not call providers directly. This keeps cost, traceability, prompt policy, tool policy, and model alias resolution in one governed path.

Laptop Copilot mode is intentionally different: Copilot runs on the user's machine, and Singularity records lifecycle events, audit evidence, questions, token usage, and completion status.

## 5. Service Inventory

Run `./singularity.sh urls` to print the current local endpoint map, and `./singularity.sh topology` to count and validate the active containers. The machine-readable topology source is `docs/platform-topology.json`; the default Docker core currently runs 8 long-running containers: one unified frontend (`platform-web`), one consolidated agent/tools backend (`platform-core`), three separate product backends (`iam-service`, `workgraph-api`, `context-api`), and three storage containers (`at-postgres`, `wg-postgres`, `wg-minio`). Two idempotent Postgres bootstrap one-shots (`at-postgres-bootstrap`, `wg-postgres-bootstrap`) must complete successfully; the Workgraph bootstrap provisions the non-bypass runtime DB role. Code Generation/Foundry APIs are served by `workgraph-api`. LLM Gateway, MCP, verifier, compressor, audit-governance, and legacy split UIs are optional local profiles or remote services.

### Web Applications

| Service | Local URL | Purpose |
|---|---:|---|
| `platform-web` | `http://localhost:5180` | Unified Next.js shell for operations, agents, workflows, workbench, foundry, identity, audit, and cost routes. |
| Legacy split UIs | debug profile only | `portal`, `workgraph-web`, `blueprint-workbench`, `user-and-capability`, and `code-foundry-web` are no longer part of the normal UI stack. |

### API and Runtime Services

| Service | URL | Responsibility |
|---|---:|---|
| `iam-service` | `http://localhost:8100/api/v1` | Authentication, JWTs, users, teams, roles, capabilities, memberships, and permissions. |
| `workgraph-api` | `http://localhost:8080/api` | WorkItems, workflows, workflow instances, tasks, approvals, metadata, triggers, artifact orchestration, runs, and `/api/codegen`. |
| `platform-core` | `http://localhost:3001-3004` | One Docker container hosting the agent-and-tools backend APIs while preserving their existing public ports and service DNS names. |
| `agent-runtime` | `http://localhost:3003/api/v1` | Agent templates, tools metadata, capabilities, execution records, memory APIs, and event subscriptions; served by `platform-core` in Docker. |
| `agent-service` | `http://localhost:3001/api/v1` | Agent application APIs and UI-facing agent service behavior; served by `platform-core` in Docker. |
| `tool-service` | `http://localhost:3002/api/v1` | Tool registry, internal tools, connector tools, runner routes, and tool discovery; served by `platform-core` in Docker. |
| `prompt-composer` | `http://localhost:3004/api/v1` | Prompt profiles, layers, assemblies, stage prompts, lessons, contracts, and compose/respond APIs; served by `platform-core` in Docker. |
| `context-api` | `http://localhost:8000` | Context Fabric execution API, optimized context, Runtime Bridge, receipts, and Agent Execution Runtime orchestration. |
| `llm-gateway` | `http://localhost:8001` | Optional/deployable provider abstraction colocated behind MCP runtime for `model-run`, model aliases, chat completions, embeddings, model/provider listing. |
| `formal-verifier` | `http://localhost:8010` | Optional formal verification service for constraints, policies, and verification receipts. |
| `mcp-server` | `http://localhost:7100` | MCP runtime relay. Normal mode dials into Context Fabric over `/api/runtime-bridge/connect`; HTTP `7100` is debug fallback. |
| `mcp-sandbox-runner` | internal compose network | Docker-based command execution runner for `run_command` and `run_test`. |
| `audit-governance-service` | commonly `http://localhost:8500` | Audit events, governance budgets, receipts, cost evidence, hook ingestion. |

### Validation Ladder

Run `./singularity.sh doctor` for the normal Docker install audit, or `bin/bare-metal-apps.sh smoke` for bare-metal platform-app health checks. Use `bin/bare-metal-runtime.sh smoke` only when local LLM Gateway and MCP are intentionally running on the same machine. The normal Docker doctor includes `bin/check-platform-topology-contract.py`, which validates `docs/platform-topology.json` against Docker Compose and operator docs, then `bin/check-platform-topology.py`, which uses the same contract to verify the 8-container core shape, the completed Postgres bootstrap one-shots, prevents running legacy frontend containers next to `platform-web`, and prevents mixing split agent/tools containers with `platform-core`. It also includes `bin/check-context-profile-evidence.py`, which locks the Context Fabric receipt contract for profile-backed runs: call-log evidence columns, compact effective-capability persistence, receipt correlation, docs, tests, and trace-spine runtime checks. `bin/check-workgraph-tenant-guards.py` prevents regressions in strict tenant guards across Workgraph runtime/admin/internal surfaces, tenant-scoped service-token contracts, and the explicit tenant-policy classification for every mounted Workgraph API route. `bin/check-workgraph-db-tenant-isolation.py` checks the Workgraph tenant DB posture: workflow/run-snapshot tenant spine, tenant index, runtime child-row connectivity, tenant RLS policy scaffold, app-role RLS-bypass posture, live null-tenant data, and forced RLS for production-class targets by default. `bin/check-workgraph-forced-rls-cutover.py` checks the guarded forced-RLS cutover contract: dry-runs stay non-mutating, apply refuses without strict-runtime confirmation, and successful apply runs both preflight and postflight RLS checks. `bin/check-workgraph-forced-rls-enforcement.py` is enabled by `SINGULARITY_DOCTOR_DEEP_SMOKE=1` or `SINGULARITY_DOCTOR_RLS_ENFORCEMENT_SMOKE=1`; it creates a throwaway DB and non-bypass role, applies the real cutover, and proves cross-tenant reads/writes are blocked. `bin/check-m25-benchmarks.sh` verifies the DB-free M25 retrieval benchmark contract for hybrid ranking, FTS/vector fallback retention, citation markers, excerpt bounds, confidence clamping, recency boost, and capsule task-signature stability. Platform Web page-route coverage plus API-proxy parity are covered by `bin/check-platform-web-routes.py` for canonical routes, legacy redirects, and sidebar surfaces, and by `bin/check-platform-api-parity.py` for canonical and legacy API proxy families returning parseable JSON instead of raw upstream HTML/text errors. For migrated UI and lifecycle parity, run `SINGULARITY_DOCTOR_DEEP_SMOKE=1 ./singularity.sh doctor`; this enables browser hydration checks plus July legacy-route parity, workflow, Workbench, Foundry, and Agent Profile lifecycle smokes. You can still run individual checks with `SINGULARITY_DOCTOR_UI_SMOKE=1`, `SINGULARITY_DOCTOR_PARITY_SMOKE=1`, `SINGULARITY_DOCTOR_LIFECYCLE_SMOKE=1`, `SINGULARITY_DOCTOR_WORKBENCH_SMOKE=1`, `SINGULARITY_DOCTOR_FOUNDRY_SMOKE=1`, or `SINGULARITY_DOCTOR_AGENT_PROFILE_SMOKE=1`. When the local audit side stack is enabled with `./singularity.sh up --profile audit`, add `SINGULARITY_DOCTOR_AUDIT_SMOKE=1` to validate strict audit DB/schema health and Platform Web audit ingest/query. Add `SINGULARITY_DOCTOR_TRACE_SPINE=1` to run the trace evidence gate across Context Fabric and audit-governance; it requires the split Postgres container, verifies the live `call_log` profile-evidence columns, and checks MCP resource views when MCP is reachable. Bare-metal operators can run the same route/API proxy/browser hydration parity checks plus mutating lifecycle smokes with `BARE_METAL_DEEP_SMOKE=1 bin/bare-metal-apps.sh smoke`, and can opt into the trace gate with `BARE_METAL_TRACE_SPINE=1 bin/bare-metal-apps.sh smoke`.

If strict tenant DB posture reports legacy `workflow_instances` rows with null
`tenantId`, runtime child rows without a workflow-instance spine, or missing
forced RLS, use `./singularity.sh tenant-isolation` as the guarded cutover. The
command dry-runs by default. With `--apply --confirm-strict-runtime`, it runs
tenant-spine backfill through the admin URL, applies the checked-in RLS policy
scaffold, enables and forces RLS, and postflights through the non-bypass runtime
app role. Rows that cannot be inferred from runtime context require an explicit
`--default-tenant-id <legacy-tenant>` selected by the operator before forced RLS
is enabled.
Production-class preflight requires the forced-RLS check by default; set
`WORKGRAPH_DB_TENANT_ISOLATION_REQUIRED=false` only when a separate database
isolation model is documented and verified. Disabling that check also requires
`WORKGRAPH_DB_TENANT_ISOLATION_ALTERNATE_MODEL` set to `schema-per-tenant`,
`database-per-tenant`, or `cluster-per-tenant`, plus
`WORKGRAPH_DB_TENANT_ISOLATION_EVIDENCE` pointing to the ticket, runbook, or
architecture record that proves the alternate isolation is deployed.
The production Workgraph app DB role must not be `SUPERUSER` and must not have
`BYPASSRLS`; `bin/check-workgraph-db-tenant-isolation.py --require-rls` fails
closed if it can bypass row security.

### Storage

| Store | Local Port | Owned Data |
|---|---:|---|
| `at-postgres` | `5432` | Agent runtime, tool service, prompt composer, Context Fabric, legacy Foundry imports, and IAM (`singularity_iam`) data. |
| `iam-postgres` | `5433` | Deprecated standalone IAM database profile only; not used by the default stack. |
| `wg-postgres` | `5434` | Workgraph workflows, WorkItems, workflow instances, metadata, triggers, questions, approvals, Foundry run history, generated artifacts, and receipts. |
| `audit-governance-postgres` | commonly `5436` | Audit events, budgets, governance and cost evidence. |
| Context Fabric stores | service-specific | Context memory and metrics stores depending on local config. |
| `wg-minio` | `9000`, console `9001` | Artifacts, workflow attachments, generated documents, evidence packs. |

## 6. Repository Layout

| Path | Purpose |
|---|---|
| `singularity.sh` | Local operator wrapper for config, compose up/down, logs, doctor, urls, and status. |
| `bin/docker-core.sh` | Plain Docker launcher for the core platform apps without Docker Compose; excludes MCP and LLM Gateway. |
| `docker-compose.yml` | Main local stack definition. |
| `seed/` | Baseline seed SQL for IAM, agent runtime, Workgraph, and audit governance. |
| `workgraph-studio/apps/api` | Workgraph API. |
| `workgraph-studio/apps/web` | Legacy/debug Workgraph web app; canonical routes live in `agent-and-tools/web`. |
| `workgraph-studio/apps/blueprint-workbench` | Legacy/debug Workbench Neo UI; canonical route is `/workbench` in Platform Web. |
| `workgraph-studio/apps/sgl-cli` | Laptop CLI for work, attach, questions, logs, doctor, and Copilot workflows. |
| `workgraph-studio/apps/desktop` | Electron desktop app for laptop-driven Copilot execution. |
| `workgraph-studio/packages/laptop-sdk` | Shared SDK used by CLI and desktop. |
| `agent-and-tools/apps/agent-runtime` | Agent templates, capabilities, execution, and memory APIs. |
| `agent-and-tools/apps/tool-service` | Tool registry and connector tool service. |
| `agent-and-tools/apps/prompt-composer` | Prompt profiles, layers, assemblies, lessons, and contracts. |
| `agent-and-tools/apps/learning-service` | Deprecated source marker; hybrid learning routes are folded into `agent-service`. |
| `agent-and-tools/web` | Canonical Platform Web Next.js app and single frontend Docker image. |
| `mcp-server` | Agent Execution Runtime implementation: code intelligence, editing tools, verification, discovery, code context, LLM invocation. |
| `mcp-sandbox-runner` | Sandboxed command execution service. |
| `context-fabric` | Context API, LLM gateway, memory, metrics, and formal verification services. |
| `singularity-iam-service` | IAM Python service. |
| `singularity-portal` | Legacy wrapper SPA retained for debug/backward compatibility. |
| `UserAndCapabillity` | Legacy user and capability management UI retained for debug/backward compatibility. |
| `singularity-code-foundry` | Legacy generator source/examples retained for migration reference; live `/foundry` APIs are Workgraph-owned. |
| `docs/` | Architecture, data model, discovery, trace, and platform documentation. |

## 7. Major Capabilities And Features

### 7.1 Identity And Capability Management

Identity is owned by `iam-service` and administered through Platform Web `/identity`.

Core features:

- Login and JWT issuance.
- Users, teams, roles, skills, permissions.
- Capability membership and ownership.
- Capability-scoped access decisions for WorkItems, workflows, agents, and metadata.
- IAM-backed default auth mode through `AUTH_PROVIDER=iam`.
- External SSO deployment mode through `IAM_AUTH_MODE=oidc`, with OIDC provider
  readiness, login URL generation, Platform Web callback/session UX,
  server-side authorization-code exchange, verified `id_token` plus nonce login,
  and federated user mapping.

### 7.2 Agent Studio

Agent Studio manages reusable and derived agent templates.

Core features:

- Locked common baselines for roles such as Architect, Developer, QA, Product Owner, Security, DevOps, and Governance.
- Capability-derived templates.
- Prompt profile and tool policy attachment.
- Model alias selection.
- Audit events for derivation and updates.

### 7.3 WorkItem Hub

WorkItems are the business object the platform routes, schedules, starts, detaches, and audits.

Core features:

- Manual WorkItem creation.
- Event-created WorkItems.
- Scheduled WorkItems using server time.
- Parent workflow delegated WorkItems.
- Routing modes: `MANUAL`, `AUTO_ATTACH`, `AUTO_START`, `SCHEDULED_START`.
- Routing states: `UNROUTED`, `ROUTED`, `ATTACHED`, `STARTED`, `ROUTE_FAILED`.
- Detach and attach workflows.
- WorkItem detail view with request packet, targets, child runs, route evidence, schedule, trigger source, and timeline.

### 7.4 Metadata Registry

The metadata registry makes WorkItem types, workflow types, node types, event types, and trigger profiles configurable without schema changes for every business type.

Definition kinds:

- `WORK_ITEM_TYPE`
- `WORKFLOW_TYPE`
- `NODE_TYPE`
- `EVENT_TYPE`
- `TRIGGER_PROFILE`

Resolution scope:

- `GLOBAL`
- `CAPABILITY`
- `WORKFLOW`
- `NODE`

Runtime objects store both metadata keys and snapshots so old runs do not change behavior when definitions evolve.

### 7.5 Workflow Designer

The workflow designer builds workflow templates from nodes and edges.

Core features:

- Miro-style large canvas direction.
- Workflow type metadata.
- Node type metadata.
- Node picker driven by metadata.
- Validation and issue panels.
- Design, Run, and Inspect concerns.
- Node configuration through inspector drawers.
- Routing, governance, inputs, outputs, retry, and advanced config sections.

### 7.6 Workflow Runtime

Workgraph executes workflow instances and manages tasks, artifacts, approvals, triggers, and WorkItems.

Common node families:

- Start and end nodes.
- Human tasks.
- Agent tasks.
- Approval gates.
- Tool requests.
- Git push and release readiness nodes.
- Workbench nodes.
- Timer, event gateway, and trigger-aware nodes.
- Custom nodes mapped to runtime executor bases.

### 7.7 Blueprint Workbench Neo

Workbench Neo is the staged story-to-delivery loop for agent-driven delivery.

Common stages:

- Story Intake.
- Plan.
- Design.
- Develop.
- Security Review.
- QA Review.
- Release Readiness.
- Test Certification.

Core features:

- Per-stage agent templates.
- Manual or automated gates.
- Expected artifacts.
- Approval and send-back flows.
- Live Cockpit events.
- Run Insights, cost, model, tool, verification, and code-change receipts.
- Developer gate requiring actual runtime/git code-change receipt.
- QA and certification gates requiring verification receipt or accepted-risk override.

### 7.8 Context Fabric

Context Fabric coordinates context assembly and agent execution.

Core features:

- `/execute` and `/execute/resume`.
- Context optimization and comparison.
- Context memory, summaries, and semantic search.
- Trace propagation.
- Context packages and receipts.
- Dependency state context.
- Laptop bridge compatibility.
- Calls to Prompt Composer for prompt assembly.
- Calls to Agent Execution Runtime for actual agent runtime invocation.

### 7.9 Prompt Composer

Prompt Composer owns reusable prompt construction.

Core features:

- Prompt profiles.
- Prompt layers.
- Prompt assemblies.
- Stage prompts.
- System prompts.
- Event Horizon actions.
- Engine lessons and global lessons.
- Contracts.
- Compose and respond endpoints.
- Debug retrieval.
- Code-aware prompt layer rendering.

### 7.10 Agent Execution Runtime / Server Runtime

The Agent Execution Runtime is the server runtime boundary for agentic coding and tools.

Core features:

- Tool listing and tool calls.
- Discovery endpoint.
- Resources endpoint.
- Events endpoint.
- Session token minting and revocation.
- Invoke and resume.
- Code intelligence.
- Differential edits and full-file write safeguards.
- Sandboxed command execution through runner.
- Verification receipts.
- Formal verification integration.
- Code Context Budgeter.
- LLM calls through LLM Gateway.

Important runtime tool families:

- File and code reading: `read_file`, `list_directory`, `search_code`.
- Code intelligence: `find_symbol`, `get_symbol`, `get_ast_slice`, `get_dependencies`, `find_references`, `find_tests`.
- Editing: `apply_patch`, `replace_text`, `replace_range`, `write_file`.
- Git and branch finishing: `finish_work_branch`, `finish_work_branch_auto`.
- Verification: `run_command`, `run_test`, `formal_verify`.
- Learning and memory: `query_learning_state`, `query_similar_capabilities`, `record_outcome_pattern`, `record_assumption`, `record_blocker`.
- Copilot advisory tools where enabled.

### 7.11 Code Context Budgeter

The Code Context Budgeter reduces coding-agent token usage by making AST-first context the default.

Target flow:

```text
Task -> Intent Detection -> Symbol Search -> AST Slice -> Dependency Expansion -> Token Budgeting -> Prompt Composer -> Context Fabric -> LLM
```

Core features:

- Code task classification.
- Target symbol resolution.
- Editable AST slices.
- Dependency slices.
- Relevant test slices.
- Type and interface contracts.
- Excluded context reasons.
- Token savings estimates.
- Full-file read policy and exception receipts.

### 7.12 Sandboxed Execution

`mcp-sandbox-runner` isolates command execution.

Target isolation properties:

- Ephemeral Docker containers.
- No network by default.
- Read-only root filesystem.
- Capability drops.
- No new privileges.
- CPU, memory, and process limits.
- Workspace-only mount.
- No provider keys or arbitrary host environment.

`run_command` and `run_test` return verification receipts with command, exit code, excerpts, duration, pass/fail, timeout state, and isolation metadata.

### 7.13 LLM Gateway

LLM Gateway abstracts providers and model aliases.

Core features:

- Provider listing.
- Model listing.
- Chat completions.
- Embeddings.
- Alias resolution.
- Usage and cost reporting when provider data is available.

Provider configuration is usually written from `.singularity/config.local.json` into local generated provider files.

### 7.14 Audit, Governance, And Cost

Audit Governance receives cross-service events and serves governance decisions.

Core features:

- Audit event ingestion.
- Hook ingestion.
- Governance budgets.
- Rate limits.
- Denied-call evidence.
- Cost and token rollups.
- Receipts.
- Run and capability correlation.
- Events for Agent Execution Runtime, Context Fabric, Workgraph, Tool Service, and Agent Runtime.

### 7.15 Learning Loop

The learning architecture is hybrid:

- `agent-service` serves the former learning summaries and pattern APIs.
- Prompt Composer `EngineLesson` remains the canonical prompt-lesson store.
- Prompt Composer merges learning summaries and patterns with existing global lessons.
- The folded learning routes require `LEARNING_SERVICE_TOKEN` for both reads and writes; Prompt Composer and MCP send that token when querying learned context.
- If the folded learning routes are unavailable, prompt assembly should degrade gracefully.

See [M35 Hybrid Learning ADR](./adr/0001-m35-hybrid-learning.md).

### 7.16 Laptop CLI And Desktop

Laptop mode supports direct Copilot execution from the user's machine.

Core features:

- `sgl` CLI.
- Electron desktop app.
- Auth.
- WorkItem picker.
- Embedded Copilot terminal.
- Events and questions.
- Heartbeats.
- Local retry queue for uploads.
- Hook callbacks.
- Token usage upload.
- Completion events.
- Diagnostics and Copilot CLI version checks.

## 8. WorkItem Metadata And Routing Model

The WorkItem-first flow is:

```text
Event / Manual / Schedule
  -> WorkItem
  -> WorkItem Type Metadata
  -> Routing Policy
  -> Workflow Type
  -> Workflow Template
  -> Workflow Instance
  -> Nodes
```

### 8.1 WorkItem Fields

Important WorkItem metadata fields:

- `workItemTypeKey`
- `typeVersion`
- `typeSnapshot`
- `routingMode`
- `scheduledAt`
- `notBefore`
- `sourceEventTypeKey`
- `routingPolicyId`
- `routingState`

### 8.2 WorkItem Type Metadata

WorkItem type metadata defines:

- Required input fields.
- Default urgency, SLA, budget, and priority.
- Allowed source types: `MANUAL`, `EVENT`, `SCHEDULE`, `PARENT_WORKFLOW`.
- Allowed routing modes.
- Compatible workflow types.
- Assignment rules.
- Approval requirements.
- UI labels and forms.

### 8.3 Routing Policies

`WorkItemRoutingPolicy` connects a WorkItem type to a workflow type or workflow template.

Important fields:

- `capabilityId`
- `workItemTypeKey`
- `workflowTypeKey`
- `workflowId`
- `routingMode`
- `priority`
- `selector`
- `isActive`

### 8.4 Triggers

`WorkItemTrigger` creates WorkItems from events, schedules, or webhooks.

Important fields:

- `triggerType`: `EVENT`, `SCHEDULE`, `WEBHOOK`
- `eventTypeKey`
- `capabilityId`
- `workItemTypeKey`
- `routingMode`
- `scheduleConfig`
- `payloadMapping`
- `dedupeKey`
- `isActive`

Scheduling uses server time and database locks for idempotency.

## 9. Important API Surfaces

### 9.1 Workgraph API

Mounted under `http://localhost:8080/api`.

Important route groups:

- `/auth`
- `/users`, `/teams`, `/identity`, `/roles`, `/skills`, `/permissions`
- `/workflow-templates`
- `/workflows`
- `/workflow-instances`
- `/workflow-triggers`
- `/custom-node-types`
- `/triggers/webhook`
- `/tasks`
- `/metadata-definitions`
- `/work-item-routing-policies`
- `/work-item-triggers`
- `/work-items`
- `/laptop-invocations`
- `/questions`
- `/approvals`
- `/consumable-types`, `/consumables`
- `/agents`, `/agent-runs`
- `/tools`, `/tool-runs`
- `/audit`, `/connectors`
- `/artifact-templates`
- `/blueprint`
- `/event-horizon`
- `/contracts`
- `/documents`
- `/runtime`, `/runs`, `/llm`, `/notify`
- `/lookup`
- `/agent-studio`
- `/receipts`
- `/events/subscriptions`, `/events/incoming`
- `/admin/feature-flags`, `/internal/feature-flags`

`/events/incoming` is intentionally outside user auth because other platform services post to it, but it is not anonymous: every event must carry `x-event-signature`, and `WORKGRAPH_INCOMING_EVENT_SECRETS` must contain a 32+ character HMAC secret for the event envelope's `source_service`.

### 9.2 Agent Execution Runtime API

Mounted under `http://localhost:7100`.

Important endpoints:

- `GET /health`
- `GET /healthz/strict`
- `GET /llm/providers`
- `GET /llm/models`
- `POST /mcp/tokens`
- `POST /mcp/tokens/:jti/revoke`
- `POST /mcp/tool-run`
- `POST /mcp/invoke` (retired legacy shim; `410 Gone` unless explicitly re-enabled for incident recovery)
- `GET /mcp/tools/list`
- `POST /mcp/tools/call`
- `GET /mcp/resources`
- `GET /mcp/events`
- `GET /mcp/discovery`
- `POST /mcp/embed`
- `POST /mcp/code-context/build`

### 9.3 Context Fabric API

Mounted under `http://localhost:8000`.

Important endpoints:

- `GET /health`
- `GET /healthz/strict`
- `POST /execute`
- `POST /execute/resume`
- `GET /execute/calls`
- `GET /execute/events`
- `GET /execute/events/stream`
- `POST /api/v1/execute-governed-single-turn`
- `POST /context/compare`
- `GET /metrics/dashboard`
- `GET /receipts`
- `/internal/mcp/...`
- `/api/runtime-bridge/connect`
- `/api/runtime-bridge/status`
- `/api/laptop-bridge/connect` and `/api/laptop-bridge/status` compatibility aliases

### 9.4 Prompt Composer API

Mounted under `http://localhost:3004/api/v1`.

Important endpoints:

- `/prompt-profiles`
- `/prompt-layers`
- `/prompt-assemblies`
- `/compose-and-respond`
- `/compose-and-respond/debug-retrieval`
- `/compiled-contexts`
- `/stage-prompts`
- `/system-prompts`
- `/event-horizon-actions`
- `/lessons`
- `/contracts`

Immutable contract replay is owned by Workgraph but executed by Context Fabric's governed single-turn endpoint. Workgraph fetches the saved `ImmutableContract` bundle from Prompt Composer, builds the replay prompt directly from the frozen `promptLayerVersions`, `systemPromptVersions`, `stageBindingVersions`, `toolPins`, `bundleHash`, and model alias metadata, then sends that prompt verbatim to `/api/v1/execute-governed-single-turn`. Replay must not ask Prompt Composer to re-assemble live prompt/profile rows after the bundle fetch. The frozen provider/model are forwarded as gateway expectations; if the saved alias now resolves to a different provider or model, the LLM gateway rejects before provider dispatch instead of silently replaying against the wrong model. `POST /contracts/:contractId/replay` accepts an optional `originalRunId`; when present, Workgraph tenant-validates that run and returns a deterministic response diff summary with content hashes, sizes, exact-match status, and first-difference excerpts against the stored `LLM_RESPONSE` output.

Prompt Composer also fails closed when minting an `ImmutableContract` if model resolution cannot be pinned. If callers omit `modelAlias`, Composer resolves and records the current catalog default alias from `/llm/models`; if a supplied or default alias cannot be found, or the catalog is unreachable, minting rejects instead of persisting `provider: "unresolved"` placeholder metadata.

Agent Runtime treats that contract pin as mandatory for production-class template activation. When an `AgentTemplate` update leaves the template `ACTIVE`, Agent Runtime waits for Prompt Composer to mint and record the `contractId`/`contractHash`. In local development a mint outage is still logged and tolerated; in production-class environments, or when `AGENT_CONTRACT_MINT_REQUIRED=true`, failed minting reverts the template status and returns `CONTRACT_MINT_REQUIRED` so an agent cannot silently publish without replay evidence.

### 9.5 Agent Runtime API

Mounted under `http://localhost:3003/api/v1`.

Important endpoints:

- `/agents`
- `/agents/profiles`
- `/agents/profiles/:id/sources`
- `/agents/profiles/:id/resolve`
- `/tools`
- `/capabilities`
- `/executions`
- `/memory`
- `/events/subscriptions`

Agent profiles are stored as `AgentTemplate` rows internally, but the user-facing profile API accepts source-backed skill bindings. Bindings can point at local skills, provider manifests, URL documents, or uploaded documents. `GET /agents/profiles/:id/sources` returns the stored source-governance summary without live network calls: local vs external counts, read-only/provider-locked state, linked knowledge sources/artifacts, and warnings for incomplete bindings. Runtime execution should call `POST /agents/profiles/:id/resolve` before use; it fetches provider manifests live, filters provider capabilities through profile permissions, fails closed for unreachable providers, and returns a deterministic effective capability set with a snapshot hash. Successful provider resolutions include non-secret manifest evidence (`manifestDigest`, `signatureKeyId`, and `signedManifest`) so runtime receipts can prove exactly which live manifest body shaped the effective capability set.

Provider manifests can be signed with `X-Manifest-Key-Id` and `X-Manifest-Signature: sha256=<hex>`, where the signature is HMAC-SHA256 over the raw manifest body. Configure trusted keys with `PROVIDER_MANIFEST_TRUSTED_KEYS` as JSON (`{"github":"32+ char secret"}`) or comma-separated `keyId:secret` pairs; production startup, doctor, and deploy preflight fail weak trusted-key secrets shorter than 32 characters. `PROVIDER_MANIFEST_SIGNATURE_MODE=auto` allows unsigned manifests only in local development when no trusted keys are configured; production-class environments must set `PROVIDER_MANIFEST_SIGNATURE_MODE=required`. Signed/provider-trusted manifests must also include `version` or `manifest_version` and an `expiresAt`/`expires_at` timestamp. Agent Runtime rejects expired manifests, future `issuedAt` timestamps, duplicate capability IDs, excessive validity windows (`PROVIDER_MANIFEST_MAX_TTL_SECONDS`, default 30 days), and insecure `http://` invocation endpoints in signed manifests.

Source-backed skills also pass through an SSRF guard before Agent Runtime previews URL documents or fetches provider manifests during resolution. Source URLs must be absolute `http`/`https` URLs, cannot include embedded credentials, and cannot target localhost, private/link-local/reserved networks, or cloud metadata hostnames. `AGENT_SOURCE_ALLOW_PRIVATE_URLS=true` is available only for deliberate local development against a private test manifest; production-class doctor and deploy preflight require `AGENT_SOURCE_ALLOW_PRIVATE_URLS=false`.

Tool-service requires a resolved profile capability set on governed discovery and invocation requests as `effective_capabilities` or `effectiveCapabilities`. That set is authoritative: `/api/v1/tools/discover` hides tools that do not have `invoke`, and `/api/v1/tools/invoke` blocks calls whose `requested_capability_id` / `requestedCapabilityId` is missing or lacks the requested permission. If the set is omitted, tool-service fails closed by default; set `TOOL_EFFECTIVE_CAPABILITY_REQUIRED=false` only for a deliberate legacy migration window.

Server-side tool invocation is also endpoint-scoped. Tool-service only fetches `runtime.endpoint_url` values that match `TOOL_SERVER_ENDPOINT_ALLOWLIST`; when unset, the allowlist is limited to the seeded internal `/api/v1/internal-tools` and `/api/v1/connector-tools` prefixes on tool-service. External/API skills that need `invoke` must add exact `https://...` provider invocation prefixes. Metadata hosts, Docker host aliases, loopback/private IP targets outside the baked internal tool-service routes, and URLs with embedded credentials are blocked even if an unsafe allowlist is configured.

Context Fabric resolves the agent profile snapshot at `/execute` time when `run_context.agent_template_id` is present, filters tool discovery with that effective set, and forwards it into MCP `runContext`. Profile-backed runs mark the effective set as required, so an empty or unavailable resolution hides/refuses tools instead of falling back to legacy-open behavior. MCP also treats any `profileSnapshotHash` as requiring the effective set and production-class deployments must set `MCP_REQUIRE_EFFECTIVE_CAPABILITIES=true`, so direct MCP dispatch cannot omit profile capability evidence and still invoke tools. The purpose-built `/mcp/work/finish-branch` endpoint uses the same effective-capability check before grant verification or any finalize/push side effect, so operational workflow hooks cannot bypass a read-only profile snapshot. MCP then forwards the same set to the Context Fabric SERVER-tool adapter, which passes it to tool-service. Context Fabric also persists `profileSnapshotHash`, non-secret `profileProviderResolutions`, and a compact `profileEffectiveCapabilities` receipt snapshot containing source/provenance, read-only/provider-locked state, manifest digest/signature evidence, and the clamped effective permission flags. Runtime-only schema bodies and invocation endpoints are intentionally omitted from the durable call log so audits can prove which provider manifest and permission set shaped the run without leaking operational endpoints into every receipt. Omitted `governance_mode` values use `DEFAULT_GOVERNANCE_MODE`; local development defaults to `fail_open`, but production-class startup, doctor, and deploy preflight require `DEFAULT_GOVERNANCE_MODE=fail_closed` so unannotated runs cannot skip the audit-governance precheck. Production deploy preflight also requires `AUDIT_GOV_URL` and verifies audit-governance `/health` before release, because fail-closed governance cannot honestly start if the ledger is unreachable. Workgraph also reads `DEFAULT_GOVERNANCE_MODE` for implicit workflow/workbench defaults, so low-risk or incomplete workflow policy does not force production calls back to fail-open. Non-blueprint workflow `AGENT_TASK` nodes default to Context Fabric's governed stage path via `WORKGRAPH_FORCE_GOVERNED_CODING=true`; explicit node opt-out or setting that env var to `false` is reserved for incident recovery and migration replay. Event Horizon chat defaults to Context Fabric's governed single-turn path via `CONTEXT_FABRIC_GOVERN_SIDE_CALLERS=true`; setting it to `false` is also an incident-recovery escape hatch. Direct MCP invokes and approval resumes use `MCP_DEFAULT_GOVERNANCE_MODE`; production-class MCP refuses to start unless it is `fail_closed`.

Mutating and high-risk MCP tool calls are also grant-bound in production. Context Fabric must run with `CF_TOOL_GRANT_ENABLED=true` and mint per-call grants using `TOOL_GRANT_SIGNING_SECRET`; MCP must run with `MCP_TOOL_GRANT_MODE=enforce`, `MCP_REQUIRE_EFFECTIVE_CAPABILITIES=true`, and the same signing secret. The grant gate covers normal `/mcp/tool-run` calls and the purpose-built `/mcp/work/finish-branch` endpoint; executor-only tools such as `run_python` are classified as `run` so they cannot bypass the gate by being absent from the agent-facing manifest. Workgraph direct `RUN_PYTHON` and `GIT_PUSH` nodes request narrow operational grants from Context Fabric when grant mode is active; Context Fabric refuses `finish_work_branch` unless the workflow has an approved gate and refuses `run_python` network access unless the node explicitly allows it. `./singularity.sh config production-guardrails` writes the fail-closed/enforce/effective-capability posture, and `./singularity.sh config rotate-secrets` rotates the shared HMAC key. This keeps MCP independently deployable while preserving the same platform policy gate when it runs on another host.

Prompt Composer renders the same effective capability metadata into the prompt stack. Tool blocks and agent skill-source layers include source type, source reference, read-only/provider-locked state, and the clamped effective permissions; provider-advertised `invoke`, `configure`, or `edit` permissions are not shown to the model when the profile/source is read-only or provider-locked.

### 9.6 Tool Service API

Mounted under `http://localhost:3002/api/v1`.

Important endpoints:

- `/tools`
- `/internal-tools`
- `/connector-tools`
- `/events/subscriptions`
- runner routes under `/api/v1`

## 10. Installation

### 10.1 Prerequisites

Install:

- Docker Desktop with Compose v2.
- Git.
- Curl.
- PostgreSQL client tools, optional but useful for seed and inspection.
- Node.js and pnpm for local package work.
- Python 3.11+ tooling for IAM, Context Fabric, bare-metal launchers, and local Python smoke helpers.

Keep these ports available:

```text
3001, 3002, 3003, 3004
5180
7100 (optional MCP)
8000, 8001 optional LLM gateway, 8010 optional verifier, 8011 optional compressor
8080, 8100
8500 (optional audit-governance side stack)
5432, 5434, 5436
9000, 9001
```

### 10.2 Clone

```bash
git clone https://github.com/ashokraj2011/singularity-platform.git
cd singularity-platform
```

### 10.3 Initialize Local Config

```bash
./singularity.sh config init --profile office-laptop
./singularity.sh config mcp-catalog --default-alias mock
./singularity.sh config write
```

Local config files live under `.singularity/` and generated env files are ignored by git. Keep provider keys and secrets local.

Rotate development defaults before any shared/staging/production deployment:

```bash
./singularity.sh config rotate-secrets
./singularity.sh config rotate-secrets --provider-manifest-key-id local-dev
./singularity.sh config rotate-secrets --include-bootstrap-password
./singularity.sh config reset-bootstrap-password
./singularity.sh config production-guardrails --tenant-id legacy-local
./singularity.sh config prepare-production --tenant-id <tenant-id> --dry-run
./singularity.sh config prepare-production --tenant-id <tenant-id>
./singularity.sh recreate iam-service
./singularity.sh config prepare-production --tenant-id <tenant-id> --skip-rotate-secrets
```

`prepare-production` is the safest shared/staging/production entrypoint: start with `--dry-run`, then run it once to apply strict tenant guardrails and rotate deploy secrets with signed provider manifests. Because rotation changes `JWT_SECRET`, `WORKGRAPH_PROXY_SERVICE_TOKEN` minting is deliberately deferred until IAM is restarted with the generated env; then rerun `prepare-production --skip-rotate-secrets` to mint the tenant-scoped `platform-web` service JWT and run deploy preflight. The lower-level commands remain available when you need one piece only. `rotate-secrets` generates strong local JWT, service, MCP bearer/runner tokens, and the shared MCP tool-grant signing secret, updates `.singularity/config.local.json`, and rewrites the generated env files. `WORKGRAPH_PROXY_SERVICE_TOKEN` is deliberately excluded from `rotate-secrets` because it must be a pre-minted IAM service JWT for `platform-web`, not a random shared secret; `mint-workgraph-proxy-token` logs into IAM or accepts `--admin-token`, mints that JWT, writes it to canonical config/env files, and preserves tenant scopes from `production-guardrails`. Platform Web also uses that JWT for server-side Prompt Composer proxy calls unless `PROMPT_COMPOSER_SERVICE_TOKEN` is explicitly set. Platform Web and Workgraph proxy service JWTs should carry read/reference scopes only; agent-runtime capability reference federation is the service path that requires `write:reference-data` in addition to `read:reference-data` and `publish:events`. IAM service-token reads are also scoped by surface: reference catalog, authz decision, and governance resolution reads require `read:reference-data`, MCP registry reads require `read:mcp-servers`, audit reads require `read:audit`, event subscription registry changes require `publish:events`, and service-authored governance writes require `governance:author` or `governance:enforce`. Human governance writes require matching `governance:author` or `governance:enforce` permissions on both the governed capability and the governing capability unless the user is a real super-admin. `--provider-manifest-key-id` also creates a trusted provider-manifest HMAC key and switches external manifests to required signatures. `production-guardrails` sets the production-class safety posture: strict tenant mode, required tenant IDs, optional auth disabled, default fail-closed Workgraph/Context Fabric/direct MCP governance, Context Fabric tool-grant minting, MCP grant verification enforcement, provider-manifest signatures required, and tenant-scoped IAM/Workgraph service-token allowlists. `--include-bootstrap-password` also rotates `LOCAL_SUPER_ADMIN_PASSWORD`; for an existing IAM database, recreate `iam-service` with the new env and then run `reset-bootstrap-password` to update the stored local credential hash.

### 10.4 Start The Stack

```bash
./singularity.sh up
```

This starts the core Docker Compose stack. Local LLM Gateway, MCP, verification, compression, and audit-governance are optional profiles or remote services. `/foundry` is included in Platform Web and backed by Workgraph.

Plain Docker without Compose uses the same core-app split:

```bash
bin/docker-core.sh up --build
bin/docker-core.sh seed
bin/docker-core.sh smoke
```

Add `--with-audit` when the local audit-governance app should run on the same host. `bin/docker-core.sh` does not start MCP or LLM Gateway; those remain dial-in runtimes and default to `host.docker.internal:7100` and `host.docker.internal:8001` for debug/direct URLs.

Bare-metal deployments use split launchers:

```bash
export SINGULARITY_PYTHON=/path/to/python3.11  # optional; only needed when python3 is older than 3.11
bin/bare-metal-apps.sh up postgres postgres localhost 5432
bin/bare-metal-runtime.sh up  # optional local LLM Gateway + MCP
```

`bin/bare-metal-apps.sh` starts all platform applications except MCP and LLM Gateway. `bin/bare-metal-runtime.sh` has its own PID file and owns only ports `8001` and `7100`. Both scripts require Python 3.11+ and prefer `SINGULARITY_PYTHON`, then `python3.12`, `python3.11`, and finally `python3` when it is new enough. If `.venv` was previously created with Python 3.9, the launchers recreate it before installing IAM or LLM Gateway dependencies.

### 10.5 Apply Seeds

```bash
bin/seed-docker.sh
```

This applies the full Docker seed path in dependency order: IAM teams/users/capabilities, common agent baselines and capability bindings, prompt-composer profiles, Workgraph artifacts/demo workflows, and SDLC workflows. Seeds are designed to be safe to re-run. Use `seed/apply.sh <db_user> [db_password] [db_host] [db_port]` only for the SQL-only bare database seed path.

### 10.6 Verify Health

```bash
./singularity.sh status
./singularity.sh urls

curl -fsS http://localhost:8080/health
curl -fsS http://localhost:8100/api/v1/health
curl -fsS http://localhost:8000/health
curl -fsS http://localhost:7100/health  # only when bin/bare-metal-runtime.sh is running
```

After schema changes, DB rebuilds, or knowledge-source backfills, verify the
M25 citation and retrieval surfaces:

```bash
PROMPT_COMPOSER_DATABASE_URL="postgresql://postgres:singularity@at-postgres:5432/singularity_composer" \
PROMPT_RUNTIME_DATABASE_URL="postgresql://postgres:singularity@at-postgres:5432/singularity" \
  ./bin/check-m25-knowledge.sh
```

The check fails closed when typed prompt evidence, compiled-context capsules,
pgvector indexes, or hybrid-retrieval `content_tsv`/GIN indexes are missing.
Use `--strict-data` after seed/backfill to also require non-empty evidence and
retrieval rows. `./singularity.sh doctor` also runs
`bin/check-m25-benchmarks.sh`, a DB-free contract that proves hybrid RRF
ranking, FTS-only and vector-only fallback retention, citation shape, excerpt
bounds, confidence clamping, recency boost behavior, and capsule
task-signature stability.

### 10.7 Login

Use the bootstrap IAM account shown by `./singularity.sh config show`. `./singularity.sh login` verifies the configured account without printing the password.

Open `http://localhost:5180` for the unified Platform Web shell:

- `/operations` for readiness, setup, and service health.
- `/agents` and `/agents/studio` for Agent Studio.
- `/workflows` for workflow manager routes.
- `/workbench` for Blueprint Workbench routes.
- `/foundry` for Code Foundry routes.
- `/identity` for IAM administration.

If an older deployment has rows in the retired `singularity_codegen` database, run `bin/migrate-code-foundry-to-workgraph.sh` once after Workgraph migrations apply. The importer hydrates artifact file content when the old `/workspace` files still exist. Set `CODE_FOUNDRY_IMPORT_TENANT_ID=<tenant-id>` when importing into strict tenant-isolated environments.

## 11. Configuration

### 11.1 Local Config Files

Important local files:

- `.singularity/config.local.json`
- `.singularity/llm-providers.json`
- `.singularity/llm-models.json`
- generated service env files created by `./singularity.sh config write`

### 11.2 Common Environment Areas

| Area | Examples |
|---|---|
| IAM | `AUTH_PROVIDER`, `IAM_AUTH_MODE`, IAM base URLs, JWT secrets, service tokens, OIDC issuer/client settings. |
| LLM | provider keys, provider URLs, default model aliases, model catalog files. |
| Agent Execution Runtime | bearer token, model alias, LLM gateway URL, command execution mode, runner URL, runner token. |
| Runner | default image, image map, network mode, host workspace path. |
| Context Fabric | Agent Execution Runtime URL, Prompt Composer URL, Agent Runtime URL, LLM Gateway URL. |
| Workgraph | database URL, MinIO config, IAM config, feature flags. |
| Audit | audit DB URL, governance budgets, hook service auth. |

### 11.3 Model Providers

Model aliases should be configured through the local catalog and gateway-facing provider config. Workbench stages should use model aliases, not raw provider strings.

Common checks:

```bash
curl -fsS http://localhost:7100/llm/providers
curl -fsS http://localhost:7100/llm/models
curl -fsS http://localhost:8001/llm/providers
curl -fsS http://localhost:8001/llm/models
```

If a run fails with `unknown model alias`, fix the alias in the stage config, runtime model catalog, or LLM Gateway config.

## 12. Operations

### 12.1 Start

```bash
./singularity.sh up
```

### 12.2 Stop

```bash
./singularity.sh down
```

This preserves data volumes.

### 12.3 Restart

```bash
./singularity.sh down
./singularity.sh up
```

### 12.4 Status And URLs

```bash
./singularity.sh status
./singularity.sh urls
```

### 12.5 Logs

```bash
./singularity.sh logs workgraph-api -f
./singularity.sh logs mcp-server -f
./singularity.sh logs context-api -f
```

### 12.6 Destructive Reset

```bash
./singularity.sh nuke
```

Use only when you intend to delete local data volumes.

## 13. Common Runtime Flows

### 13.1 Manual WorkItem To Workflow

```mermaid
sequenceDiagram
  participant U as User
  participant W as Workgraph API
  participant M as Metadata Registry
  participant R as Routing Policy
  participant WF as Workflow Runtime
  participant A as Audit

  U->>W: Create WorkItem
  W->>M: Resolve WorkItem type snapshot
  W->>R: Select workflow by type and capability
  R-->>W: Routing decision
  W->>WF: Attach or start workflow
  W->>A: Emit created, routed, attached, started events
```

### 13.2 Event To Auto-Started WorkItem

```mermaid
sequenceDiagram
  participant E as Event Source
  participant W as Workgraph API
  participant T as WorkItem Trigger
  participant S as Scheduler
  participant WF as Workflow Runtime

  E->>W: Incoming event
  W->>T: Match event type and dedupe key
  T->>W: Create WorkItem
  W->>S: Route due item
  S->>WF: Auto-start workflow if policy allows
```

### 13.3 Developer Stage In Workbench

```mermaid
sequenceDiagram
  participant WB as Workbench Neo
  participant WG as Workgraph API
  participant CF as Context Fabric
  participant PC as Prompt Composer
  participant AER as Agent Execution Runtime
  participant LLM as LLM Gateway
  participant R as Sandbox Runner
  participant AG as Audit Governance

  WB->>WG: Run Develop stage
  WG->>CF: /execute
  CF->>PC: Assemble stage prompt and code context
  CF->>AER: /mcp/tool-run per tool call
  CF->>CF: Governed LLM turn via model alias
  AER->>AER: Read, slice, patch, verify tool calls
  AER->>R: run_test or run_command
  AER->>AG: Emit code-change and verification receipts
  AER-->>CF: Outcome
  CF-->>WG: Stage result
  WG-->>WB: Live Cockpit and artifacts update
```

### 13.4 Laptop Copilot Invocation

```mermaid
sequenceDiagram
  participant CLI as sgl CLI or Desktop
  participant WG as Workgraph API
  participant AER as Agent Execution Runtime Token API
  participant CP as Copilot CLI
  participant AG as Audit Governance

  CLI->>WG: Attach to WorkItem
  CLI->>AER: Request scoped session token
  CLI->>CP: Start Copilot local execution
  CLI->>AG: Upload hooks, token usage, completion
  CLI->>WG: Heartbeat and question events
  WG-->>CLI: Answers and session state
```

## 14. Governance And Security

### 14.1 Authentication

User-facing APIs should require IAM authentication. IAM control-plane mutations require a real super-admin unless a route declares a narrower service scope. Service-to-service APIs should require service tokens, and write-capable service paths must use write scopes such as `write:reference-data` instead of broad read tokens. Service principals are not super-admins; they must pass explicit per-surface scopes such as `read:reference-data`, `read:mcp-servers`, `read:audit`, `publish:events`, `governance:author`, or `governance:enforce`, and user-only routes such as `/me` and device-token issuance reject service principals. Laptop session JWTs carry origin, client, scopes, and revocation metadata.

### 14.2 Capability Scoping

New WorkItem, workflow, metadata, laptop, and question APIs should enforce capability membership even before strict tenant isolation.

### 14.3 Tenant Isolation

Non-strict mode is still authenticated and capability-scoped. In strict mode, Workgraph `AGENT_TASK` dispatch must resolve `tenantId`/`tenant_id` from node config, workflow context, vars/globals, or WorkItem input before it can call Context Fabric; Context Fabric then also rejects calls without `run_context.tenant_id` when `REQUIRE_TENANT_ID=true`. Workflow instances and browser run snapshots persist first-class `tenantId` values, and strict-mode workflow-instance routes require `X-Tenant-Id` or `tenant_id` to match before reads, mutations, SSE/event access, or pending-execution claim/complete. Strict mode also guards Workgraph run-adjacent AgentRun, ToolRun, approval, consumable, document, code-change, receipt, insight, evidence-pack, runtime inbox, Workbench definitions, internal artifact-fetch, and feature-flag surfaces. IAM service-token minting carries `tenant_ids`, Workgraph/Context Fabric strict-mode service-token resolvers reject broad or mismatched tokens, and deploy preflight requires `IAM_SERVICE_TOKEN_TENANT_IDS` plus `WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS`; `./singularity.sh config production-guardrails --tenant-id <tenant>` writes both allowlists. `bin/check-workgraph-db-tenant-isolation.py` now verifies live Workgraph tenant data and requires forced RLS by default for production-class deploys. Workgraph has request-scoped tenant DB context helpers, a Prisma transaction proxy, workflow-instance spine, run snapshots, AgentRun, ToolRun, approval, consumable, document, code-change, receipt, insight/evidence, runtime inbox, Workbench definitions, and internal artifact-fetch routes using tenant-scoped DB transactions, checked-in RLS policy scaffolding, a runtime-spine backfill tool, and a guarded `bin/enable-workgraph-forced-rls.py` cutover. Strict production targets still need forced RLS enabled, or a schema-per-tenant deployment model, before they should be described as complete hard isolation.

### 14.4 Tool Risk

Mutating tools should be treated as risky by default:

- file edits
- command execution
- branch finishing
- connector mutation
- delegated service actions

Risky tools should produce receipts and should be approval-gated where policy requires it.

### 14.5 Command Execution

Command execution should prefer container mode. Process mode is a local/test escape hatch only.

Allowed command classes:

- tests
- lint
- typecheck
- build
- read-only diagnostics

Denied command classes:

- installs
- publishes
- deployments
- destructive filesystem operations
- shell operators
- absolute command paths
- secret environment access

## 15. Observability

### 15.1 Trace IDs

Every runtime path should carry correlation identifiers:

- `traceId`
- `runId`
- `capabilityId`
- `workflowInstanceId`
- `workflowNodeId`
- `workItemId`
- `agentRunId`

### 15.2 Receipts

Important receipt types:

- code change
- verification result
- formal verification
- approval wait
- approval decision
- context package
- full-file read exception
- LLM call completed
- governance denied
- route decision
- schedule fired
- WorkItem attached or detached

### 15.3 Dashboards

Key places to inspect behavior:

- Workbench Live Cockpit.
- Workbench Run Insights.
- Workgraph Run Insights.
- Platform Web operations surface.
- Audit event stream.
- Cost dashboard.
- Metrics Ledger.

## 16. Developer Extension Guide

### 16.1 Add A WorkItem Type

1. Create or update a `MetadataDefinition` with kind `WORK_ITEM_TYPE`.
2. Define schema, defaults, routing modes, compatible workflow types, UI form fields, and policy.
3. Add a `WorkItemRoutingPolicy` for the capability.
4. Optionally add a `WorkItemTrigger`.
5. Create a WorkItem and verify the resolved type snapshot.

### 16.2 Add A Workflow Type

1. Create a `MetadataDefinition` with kind `WORKFLOW_TYPE`.
2. Set compatible WorkItem types.
3. Mark default workflow templates where appropriate.
4. Define governance and evidence expectations.
5. Verify new WorkItems route to the intended workflow.

### 16.3 Add A Node Type

1. Create `MetadataDefinition(kind=NODE_TYPE)`.
2. Map it to a runtime executor base.
3. Define config schema, display category, input/output contracts, and edge rules.
4. Add node picker metadata.
5. Add validation tests and a designer smoke test.

### 16.4 Add A Runtime Tool

1. Implement the tool in `mcp-server/src/tools`.
2. Add schema, risk classification, and output envelope.
3. Register it in the local tool registry.
4. Add it to discovery output.
5. Add tests for success, validation, policy, and receipt shape.
6. Update Prompt Composer tool contracts if agents should prefer it.

### 16.5 Add A Prompt Layer

1. Add the layer in Prompt Composer.
2. Decide where it is retrieved and in what order it renders.
3. Add deterministic rendering tests.
4. Add debug retrieval output.
5. Verify Context Fabric receives and forwards the expected prompt package.

### 16.6 Add A Model Alias

1. Add provider configuration in local generated config.
2. Add or update runtime model catalog alias.
3. Verify through `/llm/models`.
4. Select the alias in stage config or agent template.
5. Run a small smoke stage and confirm usage/cost rolls up.

## 17. Troubleshooting

### 17.1 Port Already In Use

```bash
lsof -i :5180
lsof -i :8080
lsof -i :7100
```

Stop the conflicting process or change the port mapping.

### 17.2 Unknown Model Alias

Symptom:

```text
LLM_GATEWAY_UPSTREAM 400: unknown model alias
```

Check:

- Workbench stage selected alias.
- runtime model catalog.
- LLM Gateway provider config.
- `./singularity.sh config write` was run after config changes.

### 17.3 Workspace Locked

Symptom:

```text
workspace is locked: /workspace
```

Usually a previous Agent Execution Runtime invocation is still holding the workspace lock or a run crashed before release. Check Agent Execution Runtime logs and running invocations before deleting lock files.

### 17.4 Git Workspace Error

Symptom:

```text
ENOTDIR: not a directory, open '/workspace/.../.git/info/exclude'
```

This usually means a workspace path is not a normal git checkout or `.git` is a file pointing elsewhere. Re-materialize the workspace or use a proper worktree-aware git path routine.

### 17.5 Provider Rate Limit

Symptom:

```text
provider returned 429
```

Options:

- Reduce max input tokens.
- Use Code Context Budgeter.
- Lower history limits.
- Use a smaller or less rate-limited model alias.
- Retry after provider reset.

### 17.6 Runner Unavailable

Check:

```bash
curl -fsS http://localhost:7100/healthz/strict
./singularity.sh logs mcp-sandbox-runner -f
```

If command execution mode is `container`, Agent Execution Runtime should not silently fall back to host process execution.

### 17.7 Stale UI

If UI changes do not appear:

```bash
./singularity.sh logs platform-web -f
docker compose restart platform-web
```

Also hard-refresh the browser and confirm the browser is pointing at the expected port.

## 18. Release Checklist

Before a platform release:

- All services build.
- Unit tests pass for changed services.
- Health and strict-health endpoints pass.
- Seeds apply cleanly on a fresh stack.
- WorkItem creation works.
- WorkItem routing works.
- Workflow designer loads.
- Workbench Neo runs a small staged workflow.
- Runtime discovery lists expected tools.
- Agent Execution Runtime code edit and verification smoke passes.
- Audit events are visible.
- Cost usage is recorded.
- Context Fabric trace propagates through Agent Execution Runtime and audit;
  Workgraph → Context Fabric calls include W3C `traceparent` and
  `x-singularity-trace-id`.
- Laptop CLI doctor passes or reports actionable setup guidance.
- Deploy preflight passes with production-class guardrails:
  `bin/check-github-environment-secrets.py --github-environment <env>` to
  prove the GitHub Environment contains every required secret name from
  `docs/deploy-required-secrets.json`, and
  `bin/check-deploy-env.sh` for the target host, or
  `bin/check-deploy-env.sh --config-only --env-file <release-env>` in CI.
  This must prove strict tenant isolation, required IAM auth, signed provider
  manifests, rotated Platform Web/API/MCP service tokens, and OIDC settings
  when `IAM_AUTH_MODE=oidc`.
- Documentation is updated for changed APIs, ports, metadata, and operational steps.

## 19. Existing Detailed References

- [Data Model Overview](./data-model/00-platform-overview.md)
- [IAM Data Model](./data-model/01-iam.md)
- [Agent Runtime Data Model](./data-model/02-agent-runtime.md)
- [Prompt Composer Owned Tables](./data-model/03-prompt-composer-owned.md)
- [Prompt Composer Runtime Reads](./data-model/03-prompt-composer-runtime-read.md)
- [Workgraph Data Model](./data-model/04-workgraph.md)
- [Audit Governance Data Model](./data-model/05-audit-gov.md)
- [Tool Service Data Model](./data-model/06-tool-service.md)
- [Runtime Discovery](./runtime-discovery.md)
- [Trace Contract](./trace-contract.md)
- [M35 Hybrid Learning ADR](./adr/0001-m35-hybrid-learning.md)
