# Architecture Overview

How the Singularity platform fits together after the consolidation — **one frontend, ~9 backend services, six databases, two LLM execution paths.** Diagrams are Mermaid (GitHub renders them inline). For the per-database ERDs see [`data-model/00-platform-overview.md`](./data-model/00-platform-overview.md); for testing the two LLM paths see [`testing-copilot-and-anthropic.md`](./testing-copilot-and-anthropic.md).

---

## 1. Service architecture & connections

`platform-web` is the single origin; the **governed-run path** (`workgraph-api → context-api → backends`) is the spine. `iam-service` and `audit-governance` are cross-cutting — every service verifies tokens with IAM and emits events to audit-gov.

```mermaid
flowchart TD
  OP([Browser / Operator])
  PW["platform-web · :5180<br/>single Next.js frontend + API proxy"]
  IAM["iam-service · :8100<br/>auth · capabilities · tokens"]
  WG["workgraph-api · :8080<br/>DAG workflow runtime"]
  CF["context-api · :8000<br/>governed exec · context-fabric"]
  AR["agent-runtime · :3003<br/>agent execution"]
  PC["prompt-composer · :3004<br/>prompt assembly"]
  MCP["mcp-server · :7100<br/>tool runtime (MCP)"]
  LLM["llm-gateway · :8001<br/>LLM provider gateway"]
  AS["agent-service · :3001<br/>agents + tools"]
  AG["audit-governance · :8500<br/>audit + governance ledger"]
  ANT[(Anthropic API)]
  COP[(GitHub Copilot CLI)]

  OP --> PW
  PW --> WG
  PW --> CF
  PW --> IAM
  PW -. proxies .-> AS
  WG -- AGENT_TASK --> CF
  CF --> PC
  CF --> MCP
  CF --> LLM
  AR --> CF
  PC -. runtimeReader .-> AS
  MCP -. tool descriptors .-> AS
  MCP -- copilot_execute --> COP
  LLM --> ANT
  CF -. verify .-> IAM
  CF -. events .-> AG
  WG -. events .-> AG
  AS -. events .-> AG
  MCP -. events .-> AG
```

Solid = request/exec API · dotted = verify + audit (every service) · `agent-service` (:3001) serves **both** `/api/v1/agents` and `/api/v1/tools` (tool-service merged in). `context-memory` (:8002), `formal-verifier` (:8010), and `prompt-compressor` (:8011, compression profile) are optional and omitted above.

---

## 2. Data model

Six **disjoint** Postgres databases, each owned by exactly one service. No foreign-data-wrappers and no SQL joins across databases — they connect only through opaque UUID keys carried in payloads.

| Database | Owner service | Port | Authoritative for |
|---|---|---|---|
| `singularity_iam` | iam-service (Python) | 5432 | users, teams, business units, capabilities, roles, permissions, MCP servers, devices, IAM audit events |
| `singularity` | agent-service + agent-runtime | 5432 | agent templates, tool registry (`tool.*`), tool grants, capability metadata, code symbols, `learning.*`, distilled memory |
| `singularity_composer` | prompt-composer | 5432 | prompt profiles, layers, assemblies, stage bindings, compiled-context capsules |
| `workgraph` | workgraph-api | 5434 | workflow designs, instances, nodes, edges, tasks, approvals, agent-runs, tool-runs, triggers |
| `audit_governance` | audit-gov | 5436 | audit events, LLM calls, budgets, rate limits, authz decisions, evaluator runs |
| `singularity_context_fabric` | context-api | 5432 | `call_log` (per-turn calls), `events_store` (governed run events), `context_memory` |

**Cross-DB join keys** (opaque UUIDs, flow in JSON payloads / columns; no FK enforcement):

| Key | Origin | Consumed by |
|---|---|---|
| `capability_id` | `singularity_iam.capabilities` | `singularity.Capability` (mirror), `workgraph.capabilities`, `composer.PromptAssembly`, `audit.audit_events`, every invoke envelope |
| `user_id` | `singularity_iam.users` | `audit.audit_events.actor_id`, `singularity.AgentExecution.createdBy`, `workgraph.users`, device tokens |
| `team_id` | `singularity_iam.teams` | `workgraph.teams`, `iam.team_memberships` |
| `agent_template_id` | `singularity.AgentTemplate` | `composer.PromptAssembly`, `workgraph.agent_runs` |
| `tool_definition_id` | `singularity.ToolDefinition` | `singularity.ToolGrant`, `workgraph.tools`, `tool.tools` mirror |
| `workflow_instance_id` | `workgraph.workflow_instances` | `composer.PromptAssembly`, `audit.audit_events.subject_id`, invoke envelopes |
| `prompt_assembly_id` | `composer.PromptAssembly` | `workgraph.agent_runs`, `audit.audit_events`, cf CallLog |
| `trace_id` | minted at the edge (workgraph or cf) | `audit.audit_events`, `composer.PromptAssembly`, mcp ring buffers, every `governance.precheck` |

```mermaid
flowchart LR
  IAM[(singularity_iam<br/>users · capabilities)]
  AT[(singularity<br/>agents · tools · memory)]
  PC[(singularity_composer<br/>assemblies · capsules)]
  WG[(workgraph<br/>workflows · runs)]
  CFDB[(singularity_context_fabric<br/>call_log · events · memory)]
  AG[(audit_governance<br/>audit · llm_calls · budgets)]

  IAM -- capability_id / user_id --> AT
  IAM -- team_id / user_id --> WG
  WG -- workflow_instance_id --> CFDB
  CFDB -- agent_template_id --> PC
  PC -. runtimeReader (read-only) .-> AT
  AT -- audit events --> AG
  WG -- audit events --> AG
  CFDB -- audit events --> AG
```

---

## 3. API call flow — one governed agent run

```mermaid
sequenceDiagram
  actor U as Browser
  participant PW as platform-web :5180
  participant WG as workgraph-api :8080
  participant CF as context-api :8000
  participant IAM as iam-service :8100
  participant PC as prompt-composer :3004
  participant MCP as mcp-server :7100
  participant LLM as llm-gateway :8001
  participant AG as audit-gov :8500

  U->>PW: open /workbench, start a run
  PW->>WG: POST /api/workgraph/… (start instance)
  WG->>CF: AGENT_TASK → POST /execute (governed turn)
  CF->>IAM: verify token + capability (precheck, fail-closed)
  CF->>PC: POST /compose (assemble prompt + capsule)
  alt workbench / agent path
    CF->>LLM: POST /llm/chat → Anthropic (claude-*)
  else copilot SDLC path
    CF->>MCP: POST /mcp/tool-run {copilot_execute} → Copilot CLI
  end
  CF->>MCP: POST /mcp/tool-run (tool calls)
  CF->>AG: call_log + llm.call.completed + tool-run events
  CF-->>WG: turn result
  WG-->>PW: status + receipts
  PW-->>U: cockpit update
```

The **two LLM paths are mutually exclusive per stage**: workbench + agent runs go through the LLM gateway (Anthropic); copilot-mode SDLC stages are delegated to the Copilot CLI via `mcp-server` and captured as a diff receipt.

---

## 4. API reference (base paths + key endpoints + callers)

| Service | Base | Key endpoints | Called by |
|---|---|---|---|
| platform-web | `:5180` | `/api/*` Next routes; proxies `/api/agents`,`/api/tools`→agent-service · `/api/workgraph`→workgraph-api · `/api/cf`→context-api · `/api/audit-gov`→audit-gov · `/api/composer`→prompt-composer | Browser |
| iam-service | `:8100/api/v1` | `/auth/local/login`, `/auth/service-token`, `/auth/device-token`, `/auth/verify`, `/users`, `/capabilities`, `/mcp-servers` | all services (verify), platform-web |
| agent-service | `:3001/api/v1` | `/agents`, `/tools`, `/internal-tools`, `/connector-tools`, `/client-runners`, `/events/subscriptions` | platform-web, workgraph-api, mcp-server |
| agent-runtime | `:3003/api/v1` | `/runtime/*` (agent execution) | platform-web, workgraph-api |
| prompt-composer | `:3004` | `/compose`, `/health` | context-api |
| context-api | `:8000` | `/execute`, runtime-bridge, `/health` | workgraph-api, agent-runtime, platform-web |
| workgraph-api | `:8080` | `/api/workflows`, `/api/instances`, `/api/connectors/:id/invoke`, `/api/internal/artifacts/fetch` | platform-web, context-api |
| mcp-server | `:7100` | `/mcp/tool-run`, `/mcp/resources/*`, `/health` | context-api, agent-runtime |
| llm-gateway | `:8001` | `/llm/chat`, `/llm/models`, `/health` | context-api, prompt-composer, agent-runtime |
| audit-gov | `:8500` | `/events`, `/llm-calls`, `/budgets` | all services (fire-and-forget) |

> Storage: `at-postgres` :5432 (shared app/IAM/composer/context-fabric), `wg-postgres` :5434 (workgraph), audit-gov :5436, `wg-minio` :9000/:9001 (artifacts). In Docker the `platform-core` container bundles agent-service + agent-runtime + prompt-composer.
