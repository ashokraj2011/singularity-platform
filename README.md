# Singularity Platform

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Status: Active development](https://img.shields.io/badge/status-active-brightgreen.svg)](#)
[![Services: 11+](https://img.shields.io/badge/services-11%2B-blue.svg)](#service-inventory)

An enterprise AI-agent platform composed of independently-deployable applications: identity, agent registry, prompt composition, LLM cost optimization, workflow orchestration, an Agent Execution Runtime, a single central LLM gateway, a federated lookup + receipt + event-bus platform layer, and a unified portal that wraps them all.

> **Published as a monorepo**: `https://github.com/ashokraj2011/singularity-platform`

For the full architecture, capability, component, connection, installation, configuration, and operations guide, start with [docs/README.md](./docs/README.md), the [Singularity Platform Handbook](./docs/platform-handbook.md), or the [HTML handbook](./docs/platform-handbook.html).

---

## Quickstart — clone to demo in ~5 minutes

### Prerequisites
- Docker Desktop (Compose v2)
- `git`, `curl`, `psql` (optional, for ad-hoc inspection)
- Ports free: `3000, 5174, 5175, 5176, 5180, 7100, 8000-8003, 8080, 8100, 8500, 5432, 5433, 5434, 5436, 9000-9001`
- ~6 GB free RAM for the full stack

### 1. Clone
```bash
git clone https://github.com/ashokraj2011/singularity-platform.git
cd singularity-platform
```

### 2. Bring up — one command
```bash
./singularity.sh config init --profile office-laptop
./singularity.sh config mcp-catalog --default-alias mock
./singularity.sh config write
./singularity.sh up
./singularity.sh doctor
```

This brings up:
- **Master stack**: IAM + agent-and-tools + context-fabric + workgraph + Agent Execution Runtime (`mcp-server`) + portal + user-and-capability
- **Audit & governance ledger** (port 8500): the cross-service event ledger every producer fires into

First boot pulls images + builds web bundles. Wait ~3–5 minutes. Tail with `./singularity.sh logs workgraph-api -f` if you want to watch.

> Need to bring up just one piece? `./singularity.sh up <service-name>` works for the master-stack services (run `./singularity.sh ls` for the list). The audit-governance side stack comes up via the no-arg form.

The local configuration flow is intentionally boring:
- `.singularity/config.local.json` is the canonical local profile.
- `./singularity.sh config write` generates the per-app env files.
- Secrets stay in local ignored files, not in the Portal or git.
- `./singularity.sh doctor` writes the masked setup report used by Portal `/operations`.
- Operators only choose capability, workflow, budget preset, model alias, and runtime workspace; the platform resolves the service wiring.

### 3. Apply baseline seeds
```bash
PGPASSWORD=singularity       psql -h localhost -p 5433 -U singularity -d singularity_iam   -f seed/00-iam.sql
PGPASSWORD=singularity       psql -h localhost -p 5432 -U postgres    -d singularity       -f seed/01-agent-runtime.sql
PGPASSWORD=workgraph_secret  psql -h localhost -p 5434 -U workgraph   -d workgraph         -f seed/02-workgraph.sql
PGPASSWORD=audit             psql -h localhost -p 5436 -U postgres    -d audit_governance  -f seed/03-audit-governance.sql
```

Lands IAM teams/capabilities/memberships, common agent baselines, capability bindings, the demo workflow, and audit/cost demo rows. Re-running is safe.

### 4. One-line smoke check
```bash
for u in \
  "http://localhost:8100/api/v1/health" \
  "http://localhost:8500/health" \
  "http://localhost:7100/health" \
  "http://localhost:8000/health" \
  "http://localhost:8080/health" \
  "http://localhost:3000/api/mcp/agents/templates?scope=common&limit=3" \
  "http://localhost:5174/" \
  "http://localhost:5176/"; do
  printf "%-65s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' $u)"
done
```

You should see `200` for all eight.

### 5. The demo path — five clicks, five "wow" moments

Start from the unified Control Plane at `http://localhost:3000/control-plane`. It is the operator shell for Agent Studio, Workgraph, WorkbenchNeo, IAM, and Operations. Context Fabric, the Agent Execution Runtime, and the LLM Gateway remain separate runtime services behind that shell.

The Control Plane also exposes first-class routes under `localhost:3000` so operators can stay in one app:
`/workflows`, `/runs`, `/work-items`, `/workbench`, `/identity`, and `/operations`.

| Step | URL | What to show |
|---|---|---|
| **1. Login** | `http://localhost:5175/login` → then `http://localhost:5174` | Login with `admin@singularity.local` / `Admin1234!`, then use the IAM token in Workgraph. IAM is the source of truth for teams, roles, and capability memberships. |
| **2. Agent Studio** | `http://localhost:3000/agent-studio` → pick the seeded capability from the dropdown | Show the four **Locked** common baselines (Architect / Developer / QA / Governance), click **Derive →** on one, name it. Mention: "derived agents inherit prompt profile + tool policy, become editable by capability owners, audit-gov captures `agent.template.derived`" |
| **3. Run a workflow** | `localhost:5174/runs` → click **Run a Workflow** → pick "Business Initiative Delivery" → start | The new run lands in `/runs/<id>`. Open a HUMAN_TASK node, attach a file, click Complete. Workflow advances. |
| **4. Run Insights** | Click the green **Insights →** pill at the top of the run viewer | The M24 dashboard — total duration, per-step Gantt with precise timing (`startedAt`/`completedAt` columns), artifacts list, cost-by-model, full audit timeline keyed to the run. Mention: "every step duration is authoritative, not inferred" |
| **5. Governance & cost** | `http://localhost:3000/audit` and `http://localhost:3000/cost` | Cross-service ledger. Show the recent `agent.template.derived`, `cf.execute.completed`, `tool.execution.success`, `llm.call.completed` rows. Then `/cost` for $$ + tokens, with model breakdown. Mention: "the runtime producers — Agent Execution Runtime (`mcp-server`), workgraph-api, tool-service, context-fabric, agent-runtime — fire fire-and-forget events here; pre-flight budget/rate-limit checks happen inline." |

### 6. Optional polish for the demo

- **Set a tight budget then watch DENIED**:
  ```bash
  curl -s -X POST http://localhost:8500/api/v1/governance/budgets \
    -H 'content-type: application/json' \
    -d '{"scope_type":"capability","scope_id":"<cap-id>","period":"day","tokens_max":1}'
  ```
  Re-run any AGENT_TASK on that capability — `status:DENIED` returns instantly, no LLM dispatch. Open `/audit` → see `governance.denied` event.
- **Agent Execution Runtime smoke** (slick because it's the same call workflows make under the hood):
  ```bash
  curl -sS -X POST http://localhost:7100/mcp/invoke \
    -H 'authorization: Bearer demo-bearer-token-must-be-min-16-chars' \
    -H 'content-type: application/json' \
    -d '{"runContext":{"traceId":"t-demo","runId":"r-demo","capabilityId":"c-demo"},"message":"hi","tools":[]}'
  ```
- **Insights for a workflow that calls an LLM**: design a workflow with an AGENT_TASK, point it at a derived agent, run. Insights will populate `cost_usd` + `tokens` + model breakdown for real.

### 7. Tear down
```bash
./singularity.sh down     # stop stacks, keep data volumes
./singularity.sh nuke     # stop + WIPE all data volumes (asks for confirmation)
```

### URLs cheat sheet (print these)

```
Control Plane           http://localhost:3000/control-plane    unified operator shell
Control Plane routes    http://localhost:3000/workflows        workflows inside the unified shell
                        http://localhost:3000/runs             run dashboard inside the unified shell
                        http://localhost:3000/work-items       WorkItem queue inside the unified shell
                        http://localhost:3000/workbench        WorkbenchNeo inside the unified shell
                        http://localhost:3000/identity         IAM admin inside the unified shell
                        http://localhost:3000/operations       Operations inside the unified shell
Workgraph SPA            http://localhost:5174    runs, designer, insights
Blueprint Workbench      http://localhost:5176    staged agent loop + approvals
Agent / Tools SPA        http://localhost:3000    Agent Studio, /audit, /cost
Singularity Portal       http://localhost:5180    branded wrapper around all of it
User & Capability SPA    http://localhost:5175    IAM admin

Workgraph API            http://localhost:8080
Agent Runtime API        http://localhost:3003
Tool Service API         http://localhost:3002
Prompt Composer API      http://localhost:3004
Context Fabric API       http://localhost:8000
Agent Execution Runtime               http://localhost:7100
IAM API                  http://localhost:8100/api/v1
Audit & Governance API   http://localhost:8500
```

### Known gotchas (fix before the demo)

1. **First boot of agent-runtime fails seed** if `pgvector` extension isn't created. The compose's `at-postgres` is a pgvector image so this is usually OK; if you see `type "vector" does not exist` after a force-reset:
   ```bash
   docker exec agentandtools-postgres psql -U postgres -d singularity -c "CREATE EXTENSION IF NOT EXISTS vector;"
   ```
2. **Token errors after a long idle**: IAM tokens expire. Re-login at `localhost:5175/login` and refresh Workgraph.
3. **Port collisions** — `lsof -i :5174` if the workgraph SPA won't start; another stack from a previous demo might still be holding it.

The narrative to lead with: *"Singularity is a governed agent platform — every agent is rooted in a locked baseline, every workflow run is observable end-to-end, and every LLM call is gated against a budget."*

---

## Per-component adoption (M65)

The platform is monorepo-shipped but operators can adopt subsets:

```bash
docker compose --profile full          up -d   # all 25 services (default; see .env COMPOSE_PROFILES=full)
docker compose --profile gateway-only  up -d   # llm-gateway + at-postgres only (managed LLM gateway with provider keys)
docker compose --profile composer-only up -d   # gateway-only + prompt-composer (composer stack)
```

Each major service has its own `RELEASE.md` documenting API surface,
env vars, dependencies, and M-numbered milestone history:

| Service             | File                                                                          |
|---------------------|-------------------------------------------------------------------------------|
| llm-gateway         | [`context-fabric/services/llm_gateway_service/RELEASE.md`](./context-fabric/services/llm_gateway_service/RELEASE.md) |
| prompt-composer     | [`agent-and-tools/apps/prompt-composer/RELEASE.md`](./agent-and-tools/apps/prompt-composer/RELEASE.md) |
| audit-governance    | [`audit-governance-service/RELEASE.md`](./audit-governance-service/RELEASE.md) |
| mcp-server          | [`mcp-server/RELEASE.md`](./mcp-server/RELEASE.md)                            |
| prompt-compressor   | [`context-fabric/services/prompt_compressor_service/RELEASE.md`](./context-fabric/services/prompt_compressor_service/RELEASE.md) |
| formal-verifier     | [`context-fabric/services/formal_verifier_service/RELEASE.md`](./context-fabric/services/formal_verifier_service/RELEASE.md) |

Pinning a specific milestone build: any push of an `M*` git tag
triggers `.github/workflows/build-images.yml`, which pushes images
tagged `ghcr.io/<owner>/singularity-<service>:M64` (and `:latest`).
Operators wanting reproducible deployments author a
`docker-compose.pinned.yml` override that swaps `build:` for
`image: ghcr.io/…:M64`.

---

## Bare-metal alternative — single Postgres, no Docker

For dev machines that already have Postgres and don't want Docker. Runs real IAM, agent-and-tools services, Workgraph API/web, blueprint-workbench, audit-governance, context-api, context-memory, formal-verifier, the local Agent Execution Runtime, the UserAndCapabillity SPA (IAM admin + capability-governance authoring), and the portal. Context Fabric stores run on Postgres (DB `singularity_context_fabric`), matching the Docker stack. It skips metrics-ledger (sunset; savings moved to audit-gov) and MinIO.

### Simplest — the interactive wizard

```bash
bin/setup.sh        # asks Postgres + LLM, then brings everything up, seeds, smoke-checks, prints URLs
bin/setup.sh --yes  # non-interactive: reuse saved answers (.singularity/setup.conf) or defaults
```

It wraps everything below — collects a few answers once, runs the stack, optionally points the LLM gateway at an OpenAI-compatible bridge (Copilot etc.), and remembers your answers for next time.

### Or run the stack script directly

```bash
bin/bare-metal.sh up <db_user> [db_password] [db_host] [db_port]
bin/bare-metal.sh smoke      # curl every /health endpoint
bin/bare-metal.sh status     # list running PIDs
bin/bare-metal.sh logs workgraph-api    # tail one service
bin/bare-metal.sh down       # stop everything + free ports
```

Idempotent — re-runs of `up` skip installs and DB creation if they already happened, just re-boots. Defaults: `db_password` from `$PGPASSWORD` env or `postgres`, `db_host=localhost`, `db_port=5432`.

The bare-metal path applies the same seed bundle as Docker: `seed/00-iam.sql`, `seed/01-agent-runtime.sql`, `seed/02-workgraph.sql`, and `seed/03-audit-governance.sql`.

The manual recipe below is what the script does under the hood — useful if you want to step through it or diverge.

### 1. Postgres prep — one shot
Adjust user/password to match your instance (defaults: `postgres@localhost:5432`).

```bash
psql postgres <<'SQL'
CREATE DATABASE singularity;
CREATE DATABASE workgraph;
CREATE DATABASE audit_governance;
CREATE DATABASE singularity_iam;
\c singularity
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\c audit_governance
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL

# Apply audit-gov schema (7 tables + rate_card seed)
psql -d audit_governance -f audit-governance-service/db/init.sql
```

### 2. Single env file
```bash
cat > .env.local <<'EOF'
export PG_HOST=localhost
export PG_PORT=5432
export PG_USER=postgres
export PG_PASS=postgres

export DATABASE_URL_AGENT_TOOLS="postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/singularity"
export DATABASE_URL_WORKGRAPH="postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/workgraph"
export DATABASE_URL_AUDIT_GOV="postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/audit_governance"

# Shared JWT secret (32+ chars — workgraph-api enforces)
export JWT_SECRET="dev-secret-change-in-prod-min-32-chars!!"

export AUTH_PROVIDER="iam"
export IAM_BASE_URL="http://localhost:8100/api/v1"
export IAM_SERVICE_URL="http://localhost:8100"

# Cross-service URLs
export AUDIT_GOV_URL="http://localhost:8500"
export PROMPT_COMPOSER_URL="http://localhost:3004"
export AGENT_RUNTIME_URL="http://localhost:3003"
export TOOL_SERVICE_URL="http://localhost:3002"
export AGENT_SERVICE_URL="http://localhost:3001"
export CONTEXT_FABRIC_URL="http://localhost:8000"
export MCP_SERVER_URL="http://localhost:7100"
export MCP_BEARER_TOKEN="demo-bearer-token-must-be-min-16-chars"

# LLM gateway mock by default — no API keys required
export LLM_GATEWAY_URL="http://localhost:8001"
export WORKBENCH_DEFAULT_MODEL_ALIAS="mock"
EOF

source .env.local
```

### 3. Install + push schemas (one-time)
```bash
( cd agent-and-tools          && npm install )
( cd workgraph-studio         && pnpm install )
( cd audit-governance-service && npm install )
( cd mcp-server               && npm install )

# Python deps for IAM + context-api
python3 -m pip install -e singularity-iam-service
python3 -m pip install fastapi uvicorn httpx pydantic-settings \
                       python-jose[cryptography] sqlalchemy aiosqlite

# Prisma push for agent-runtime
( cd agent-and-tools/apps/agent-runtime \
  && DATABASE_URL="$DATABASE_URL_AGENT_TOOLS" npx prisma db push --skip-generate \
  && DATABASE_URL="$DATABASE_URL_AGENT_TOOLS" npx prisma generate )

# Prisma client for prompt-composer
( cd agent-and-tools/apps/prompt-composer \
  && DATABASE_URL="$DATABASE_URL_AGENT_TOOLS" npx prisma generate )

# Prisma push for workgraph-api
( cd workgraph-studio/apps/api \
  && DATABASE_URL="$DATABASE_URL_WORKGRAPH" npx prisma db push --skip-generate \
  && DATABASE_URL="$DATABASE_URL_WORKGRAPH" npx prisma generate )
```

### 4. Boot + seed

Use the launcher unless you specifically need to debug one command at a time. It starts real IAM first, waits for `/api/v1/health`, applies all four seed SQL files, then starts the rest of the demo services.

```bash
bin/bare-metal.sh up postgres postgres localhost 5432
```

### 5. Smoke check
```bash
for url in \
  http://localhost:8100/api/v1/health \
  http://localhost:8500/health \
  http://localhost:7100/health \
  http://localhost:8000/health \
  http://localhost:8080/health \
  "http://localhost:3000/api/mcp/agents/templates?scope=common&limit=3" \
  http://localhost:5174/ \
  http://localhost:5176/ \
  ; do
  printf "%-65s %s\n" "$url" "$(curl -s -o /dev/null -w '%{http_code}' "$url")"
done
```

All eight should return `200`. Open `http://localhost:5174` for Workgraph, `http://localhost:5176` for Blueprint Workbench, and `http://localhost:3000` for Agent Studio. IAM login is `admin@singularity.local` / `Admin1234!`.

### Tear down
```bash
bin/bare-metal.sh down
# Optional — wipe data:
psql postgres -c "DROP DATABASE singularity; DROP DATABASE workgraph; DROP DATABASE audit_governance; DROP DATABASE singularity_iam;"
```

### What's intentionally skipped

| Skipped | Impact |
|---|---|
| llm-gateway, context-memory, metrics-ledger | None — context-api calls the Agent Execution Runtime (`mcp-server`) directly; the runtime's embedded LLM is mock |
| MinIO | File uploads return 5xx; insights, Agent Studio, audit, cost all still work |
| portal (`:5180`), user-and-capability (`:5175`) | Optional UI wrappers; `:5174` + `:3000` cover the demo path |

Common boot failures: (a) wrong `PG_USER`/`PG_PASS`, (b) `pgvector` extension not installed in `singularity`, (c) port collision (`lsof -i :3003`).

---

## Recent (M9.z – M11)

The platform layer (M11) and supporting milestones landed as a cohesive set; everything below is shipped + smoke-tested end-to-end.

| Milestone | What it added | Verification |
|---|---|---|
| **M9.z** Approval pause/resume | Agent Execution Runtime `/mcp/resume` + cf `/execute/resume` + workgraph `AgentRunStatus.PAUSED` + `POST /agent-runs/:id/approve`. Single-use continuation tokens, 24h TTL. | Full workflow → tool requires_approval → workgraph PAUSED → UI approve → Agent Execution Runtime resumes loop → AWAITING_REVIEW |
| **M10** Federated lookups | workgraph `/api/lookup/*` proxies to IAM + agent-and-tools with user-JWT forwarding; NodeInspector pickers; Agent/Tool snapshot at AGENT_TASK start (`externalTemplateId`) | Picker dropdowns populated from real services; snapshot row written on first run, reused afterwards |
| **M11.a** Service + Contract Registry | New `platform-registry` :8090 + Postgres :5435; per-service self-register helper (TS + Python); 11 services + 47 capabilities + contracts browsable | `GET :8090/api/v1/services` returns 12 (11 production + sample) |
| **M11.b** Reference Resolver | `GET /api/lookup/:entity/:id` for 9 kinds; `POST /api/lookup/resolve` batch (200/207); write-time validation in workflow design POST/PATCH (422 on bad ref) | bogus refs → 422 with field-level failure; valid → 201 |
| **M11.c** Snapshot provenance | `sourceHash`/`sourceVersion`/`fetchedBy` on snapshots; new `prompt_profile_snapshots` + `capability_snapshots` tables; canonical-JSON sha256 dedupe | 3 runs of same workflow → 1 capability snapshot row |
| **M11.d** Unified Receipt envelope | cf `GET /receipts?trace_id=` + workgraph `GET /api/receipts?trace_id=` joins workgraph + cf + Agent Execution Runtime audit | 14 receipts merged from 3 services in chronological order |
| **M11.e** Event Bus | `event_outbox` + `event_subscriptions` + `event_deliveries` in 5 publishers (IAM Python, workgraph TS, agent-runtime TS, tool-service TS, agent-service TS); Postgres LISTEN/NOTIFY dispatcher with 30s safety sweep, HMAC, 5-attempt retry; workgraph receiver at `POST /api/events/incoming`; canonical envelope shape across all publishers | Subscribe to `*.created` → trigger from any service → workgraph `event_log` captures with `incoming.<event_name>` |
| **M11 follow-up** OTel + Jaeger | Auto-instrumentation in workgraph-api (TS), context-api (Python), tool-service (TS), agent-runtime (TS), agent-service (TS); Jaeger all-in-one in `platform-registry` compose; W3C `traceparent` propagated automatically | Single trace `1cc8ef8ac9a1207b` had **59 spans across 4 services**. UI: `http://localhost:16686` |
| **M11 follow-up** Service-token auto-mint | IAM `POST /api/v1/auth/service-token` + workgraph + cf bootstrap + `IAM_BOOTSTRAP_USERNAME/PASSWORD` env. Replaces 60-min admin-JWT-passing-via-env. | Both services start with `IAM_SERVICE_TOKEN=""`, mint 30-day tokens on first call |
| **M11 follow-up / M33 hardened** Central LLM gateway | `context-fabric/services/llm_gateway_service` is the only provider-calling service. Agent Execution Runtime, Workgraph, Prompt Composer, Agent Runtime, and Context Memory send `model_alias` requests to `LLM_GATEWAY_URL`. | Missing non-mock provider config fails closed. `ALLOW_CALLER_PROVIDER_OVERRIDE=false` by default. The only implicit fallback is explicit mock mode. |
| **M42.7** Phased Agent Reasoning Model (v4) | Replaces the flat ReAct loop in mcp-server with an opt-in 6-phase state machine (`PLAN_DRAFT → EXPLORE → PLAN_CONFIRM → ACT → VERIFY → FINALIZE`). Per-phase tool allowlists, robust plan JSON extraction, path-coverage gate (lazy-edit fix), phase-aware repetition detection, backward-compatible approval pause/resume. See [Phased Agent Reasoning Model](#phased-agent-reasoning-model-v4) below. | Flip `MCP_AGENT_PHASES_ENABLED=true` + `WORKBENCH_AGENT_PHASES_ENABLED=true` in `.env`. `pnpm --filter @singularity/mcp-server test`: 137/139 passing (was 67; +70 new). `./bin/trace.sh --latest --stage develop` shows phase transitions. |

---

```
                     Singularity Portal (:5180)
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
     UserAndCapabillity  Agent & Tools     Workgraph Studio
            (:5175)        (:3000)            (:5174)
            │                 │                 │
            ▼                 ▼                 ▼
       IAM Service      ┌─prompt-composer (:3004)─┐
        (:8100)         │  agent-runtime  (:3003)  │      Workgraph API
            │           │  tool-service   (:3002)  │         (:8080)
            │           │  agent-service  (:3001)  │             │
            │           └──────────────────────────┘             │
            │                       │                            │
            │                       ▼                            │
            │             Context Fabric (:8000)                 │
            │             llm-gateway (:8001)                    │
            │             memory      (:8002)                    │
            │             metrics     (:8003)                    │
            │                                                    │
            └────────────── shared IAM JWT ──────────────────────┘
```

---

## Table of Contents

- [What's in the box](#whats-in-the-box)
- [The five planes](#the-five-planes)
- [Quick start](#quick-start)
  - [Option A — master compose (one shot)](#option-a--master-compose-one-shot)
  - [Option B — singularity.sh CLI](#option-b--singularitysh-cli)
  - [Option C — per-app compose files](#option-c--per-app-compose-files)
- [Service inventory](#service-inventory)
- [Data model](#data-model)
- [Using the platform](#using-the-platform)
- [End-to-end demo: workgraph DAG calls composer calls context-fabric](#end-to-end-demo)
- [`singularity.sh` cheatsheet](#singularitysh-cheatsheet)
- [Architecture deep-dive](#architecture-deep-dive)
- [Migration history (what was built)](#migration-history)
- [Phased Agent Reasoning Model (v4)](#phased-agent-reasoning-model-v4)
- [Troubleshooting](#troubleshooting)
- [Open items / roadmap](#open-items)

---

## What's in the box

| App | Role | Stack | Ports |
|-----|------|-------|-------|
| **singularity-iam-service** | Identity, orgs, teams, roles, capabilities, skills, JWT, Agent Execution Runtime registry, service-token mint, event bus | Python · FastAPI · Postgres | `8100`, postgres `5433` |
| **agent-and-tools** | Agent definitions, tool registry, prompt assembly, agent CRUD UI; per-service event bus + OTel | TypeScript monorepo · Express · Next.js · Prisma · Postgres+pgvector | `3000–3004`, postgres `5432` |
| **context-fabric** | LLM cost optimizer (context compaction + token-saving ledger), `/execute` orchestrator, `/receipts` join, OTel | Python · 4× FastAPI · SQLite | `8000–8003` |
| **mcp-server** | Agent Execution Runtime implementation and WS bridge. Customer-deployed, owns local tools/AST/branches, and calls the central LLM gateway by model alias. Ships with an opt-in [Phased Agent Reasoning Model](#phased-agent-reasoning-model-v4) (6-phase state machine with path-coverage gate) behind `MCP_AGENT_PHASES_ENABLED`. The service/package name is legacy. | TypeScript · Express · WebSocket | `7100` |
| **workgraph-studio** | Visual DAG designer + workflow runtime, Blueprint Workbench stage loop, federated `/api/lookup/*`, snapshot layer, unified `/api/receipts`, event bus + receiver, OTel | React + ReactFlow + Zustand · Express + Prisma · MinIO | `5174` (web) / `5176` (workbench) / `8080` (api), postgres `5434`, minio `9000-9001` |
| **platform-registry** | Service + Contract Registry: every service self-registers on startup with capabilities + OpenAPI/event/node contracts | TypeScript · Express · Postgres | `8090`, postgres `5435` |
| **UserAndCapabillity** | Visual admin SPA for IAM | React 19 · Vite · Tailwind · Radix · Zustand | `5175` |
| **singularity-portal** | The wrapper SPA — single login + dashboard tiles + deep links | React 19 · Vite · Tailwind · Radix | `5180` |
| **jaeger** (observability) | All-in-one OTel trace UI; receives spans from all instrumented services | docker image | `16686` (UI), `4317`/`4318` (OTLP) |

11 production services. Each owns its database. `capability_id` is the join key across them; joins happen at the application layer, never in SQL.

---

## The five planes

A useful mental model when deciding "which app should this feature live in?" — match the responsibility to its plane.

```
┌───────────────────────────────────────────────────────────┐
│ CONTROL          IAM + UserAndCapabillity + Portal        │
│  decides WHO can do WHAT; humans configure here           │
└───────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────┐
│ ORCHESTRATION    workgraph-studio                         │
│  decides WHEN and IN WHAT ORDER work happens              │
└───────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────┐
│ COMPOSITION      prompt-composer (inside agent-and-tools) │
│  decides WHAT TO SAY to the LLM (layered prompts +        │
│  workflow context + tool contracts + artifacts)           │
└───────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────┐
│ DATA             agent-and-tools (registries, memory)     │
│  the WHAT of the work (templates, tools, knowledge)       │
└───────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────┐
│ OPTIMIZATION     context-fabric                           │
│  makes LLM calls cheaper (compaction + cost tracking)     │
└───────────────────────────────────────────────────────────┘
```

---

## Quick start

### Prerequisites

- Docker Desktop (or Docker Engine + the Compose v2 plugin)
- 8 GB+ RAM available to Docker
- Free host ports: `3000–3004`, `5174–5176`, `5180`, `5432–5434`, `8000–8003`, `8080`, `8100`, `9000–9001`
- Optional: explicit central LLM gateway provider config. Fresh local setup is mock-only; office setup is Copilot-only.

### Option A — master compose (one shot)

```bash
cd /path/to/SingularityNeoNew
docker compose up -d                       # builds + starts 18 containers
docker compose ps                          # see what's running
```

Then open **http://localhost:5180** and log in with `admin@singularity.local` / `Admin1234!`.

To tear down (keeps data):
```bash
docker compose down
```

To wipe data volumes:
```bash
docker compose down -v
```

### Option B — `singularity.sh` CLI

Wraps the master compose with friendlier subcommands. Useful for starting/stopping individual services.

```bash
./singularity.sh up                        # start all
./singularity.sh up portal                 # start just the portal
./singularity.sh status                    # ps
./singularity.sh urls                      # color-coded URL cheatsheet
./singularity.sh logs workgraph-api -f     # follow logs
./singularity.sh restart prompt-composer
./singularity.sh stop workgraph-web
./singularity.sh down                      # stop all (keep data)
./singularity.sh nuke                      # stop + delete data volumes (confirms)
./singularity.sh login                     # smoke-test IAM /auth/local/login
./singularity.sh doctor                    # validate DBs, endpoints, LLM keys, Agent Execution Runtime
./singularity.sh config init --profile office-laptop
./singularity.sh config office-copilot-only
./singularity.sh config interactive        # guided local configuration wizard
./singularity.sh ls                        # list known service names
./singularity.sh build [service]           # rebuild image(s)
./singularity.sh help                      # full usage
```

### Central configuration utility

Use `./singularity.sh config ...` when you need one place to manage the platform knobs that otherwise live across app-specific `.env` files. The v1 model is **hybrid local-first**: the canonical profile is `.singularity/config.local.json`, generated env files are written from it, and secrets stay on the laptop. The Portal `/operations` page shows the latest `./singularity.sh doctor` summary and never asks you to paste provider keys into the browser.

It configures:

- Database URLs for IAM, agent-and-tools, and Workgraph.
- IAM vs pseudo-IAM endpoints.
- Service endpoints for Workgraph, prompt-composer, context-fabric, agent-runtime, tool-service, agent-service, and Agent Execution Runtime.
- LLM provider policy and model aliases for the central gateway. Provider policy lives in `.singularity/llm-providers.json`; secrets are passed only to the `llm-gateway` service.
- Office-safe Copilot-only mode. `./singularity.sh config office-copilot-only` blanks OpenAI/OpenRouter/Anthropic/Ollama access in canonical config and generated env files, writes Copilot-only provider and model catalog files, and fences the gateway to the Copilot provider.
- Default/local Agent Execution Runtime URL, bearer token, public URL, sandbox root, AST index path, and local work-branch defaults. The Agent Execution Runtime does **not** need to belong to a capability; capability-specific Agent Execution Runtime registration is advanced-only.
- Git push credentials for approved WorkItem branches. The canonical config stores only mode, remote name, token env name, or SSH key path; it never stores a token or key body. The Agent Execution Runtime is the only service that receives Git push credentials.
- Gateway-owned model aliases. Workflows choose aliases; Agent Execution Runtime forwards aliases and receives resolved provider/model in receipts.
- Balanced token budget defaults. Workgraph owns run budgets, Prompt Composer owns layer/retrieval budgeting, Context Fabric enforces execution limits, and the central gateway owns provider/model routing.
- Governed artifact fetch for prompt assembly. Prompt Composer can fetch bounded text from Workgraph MinIO/document refs through `WORKGRAPH_ARTIFACT_FETCH_URL` using `WORKGRAPH_ARTIFACT_FETCH_TOKEN`; required artifacts fail closed if only a missing/unreadable ref is provided.
- Optional formal verification. `formalVerification.enabled` maps to `FORMAL_VERIFICATION_ENABLED`; the default is `false`, so governance path controls are disabled/skipped unless an operator explicitly enables the SMT verifier.
- UI env files for the portal, Workgraph web, IAM admin, and agent-and-tools web.

Common commands:

```bash
./singularity.sh config init --profile office-laptop
./singularity.sh config interactive
./singularity.sh config office-copilot-only
./singularity.sh config mcp --base-url http://localhost:7100 --sandbox-root /path/to/repo
./singularity.sh config git --mode ssh --ssh-key ~/.ssh/id_ed25519 --remote origin
./singularity.sh config git --mode token --token-env GITHUB_TOKEN --remote origin
./singularity.sh config mcp-catalog --default-alias mock
./singularity.sh config providers
./singularity.sh config models
./singularity.sh config show
./singularity.sh doctor
./singularity.sh doctor git
./singularity.sh doctor secrets
./singularity.sh config export
```

`show` masks secrets. `doctor` checks the canonical config, env drift, common ports, reachable service URLs, provider key presence, runtime token length, model-catalog readiness, Git push readiness, and tracked-file secret guardrails. `doctor git` focuses on workspace writability, remote, Git identity, and auth presence. `doctor secrets` scans tracked files for local-only config, credentialed remotes, provider keys, GitHub tokens, bearer tokens, JWT-like tokens, and private-key blocks. It also writes `singularity-portal/public/ops-doctor.json` so the Portal Setup Center can show the same status. For bare-metal runs, use `config export` to print shell exports without editing files.

Git push credential boundary:

- Default is disabled: `GIT_PUSH` nodes preserve branch/commit evidence and block with `GIT_AUTH_MISSING`.
- SSH mode mounts only the selected key path or SSH agent socket into `mcp-server`, read-only.
- Token mode passes only the selected env var value, such as `GITHUB_TOKEN`, into Agent Execution Runtime. Tokens are not written to `.singularity/config.local.json`.
- Agent Execution Runtime redacts credentialed remotes, GitHub PATs, provider keys, bearer tokens, private keys, and token-shaped values before returning output, writing audit events, or creating receipts.
- Workgraph shows `COMMITTED_NOT_PUSHED` when the local commit exists but publishing failed; use `Retry push` after fixing credentials so Workbench does not rerun.

Office laptop / Copilot-only setup:

```bash
./singularity.sh config init --profile office-copilot-only --force
# optional if you have a Copilot API token; gh copilot CLI tools work separately
./singularity.sh config set llm.copilot.token "$COPILOT_TOKEN"
./singularity.sh config office-copilot-only
./singularity.sh doctor
cd mcp-server && npm run build && npx singularity-mcp doctor
```

This mode is intentionally strict: generated env files leave `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, and `OLLAMA_BASE_URL` blank. Workflows still choose model aliases, but the gateway exposes only the `copilot` alias.

### Single LLM gateway configuration

`context-fabric/services/llm_gateway_service` owns provider/model routing for workflow execution. Workgraph, Context Fabric, Prompt Composer, Context Memory, Agent Runtime, and Agent Execution Runtime pass a model alias to `LLM_GATEWAY_URL`; only the gateway can hold provider credentials or open provider URLs. Raw provider/model caller overrides are disabled by default with `ALLOW_CALLER_PROVIDER_OVERRIDE=false`.

The gateway reads two local JSON files:

- `.singularity/llm-providers.json` — provider policy: allowlist, default provider/model, base URLs, credential env names, and enabled/disabled flags.
- `.singularity/llm-models.json` — approved workflow-facing model aliases. Workflows choose aliases; the gateway resolves aliases to real providers/models.

These generated files are intentionally ignored by git because they are local setup state. Checked-in examples live under:

- `mcp-server/examples/llm-providers.default.json`
- `mcp-server/examples/llm-providers.copilot-only.json`

The provider config is selected with:

```bash
LLM_PROVIDER_CONFIG_PATH=/etc/singularity/llm-providers.json
LLM_MODEL_CATALOG_PATH=/etc/singularity/llm-models.json
```

Secrets stay in generated env files, not JSON, and are passed only to `llm-gateway`:

```bash
COPILOT_TOKEN=...
```

Example Copilot-only provider config:

```json
{
  "defaultProvider": "copilot",
  "defaultModel": "gpt-4o",
  "allowedProviders": ["copilot"],
  "providers": {
    "copilot": {
      "enabled": true,
      "baseUrl": "https://api.githubcopilot.com",
      "defaultModel": "gpt-4o",
      "credentialEnv": "COPILOT_TOKEN",
      "supportsTools": true
    },
    "openai": { "enabled": false },
    "openrouter": { "enabled": false },
    "anthropic": { "enabled": false },
    "mock": { "enabled": false }
  }
}
```

Useful commands:

```bash
# Generate local mock-only provider/model config.
./singularity.sh config mcp-catalog --default-alias mock

# Generate strict office mode: only Copilot is exposed.
./singularity.sh config office-copilot-only

# Inspect provider policy readiness.
./singularity.sh config providers

# Inspect workflow-facing model aliases.
./singularity.sh config models

# Write generated env files from .singularity/config.local.json.
./singularity.sh config write

# Restart Agent Execution Runtime so it reloads provider/model config.
./singularity.sh restart mcp-server
```

Runtime verification:

```bash
curl http://localhost:7100/llm/providers
curl http://localhost:7100/llm/models
```

In office Copilot-only mode, `/llm/providers` should report `copilot` as allowed/enabled and `openai`, `openrouter`, `anthropic`, and `mock` as disabled or not allowed. If a workflow tries to force a disabled provider or raw provider/model, the gateway rejects it before any provider call.

### Optional governance path analyzer

Formal verification is a platform-level feature toggle, off by default:

```bash
./singularity.sh config set formalVerification.enabled true
./singularity.sh config write
./singularity.sh restart formal-verifier workgraph-api portal
```

When disabled, Workgraph formal-analysis endpoints return `FORMAL_VERIFICATION_DISABLED`, Policy Check nodes using `engine=formal_verifier` are marked skipped with an audit receipt, and no solver call is made. When enabled, `formal-verifier` exposes `/health`, `/healthz/strict`, and `/api/v1/verification/verify`, and Operations Portal shows **Governance Paths** for workflow/run analysis.

### Operator command center and guided delivery

The Operations Portal (`http://localhost:5180/operations`) is the command center for day-to-day governed delivery:

- **Setup Center** — service health, DNS/reachability, config doctor summary, runtime/model readiness, and generated env drift.
- **Readiness** — capability readiness score from agent-runtime: identity/governance, agent team, knowledge/code, workflow readiness, and runtime readiness.
- **Run Audit** — evidence-pack export for a workflow run with stage timings, tokens/cost, approvals, artifacts, receipts, Workbench stages, budget events, and gaps.
- **WorkItems** — cross-capability WorkItem queue with child capability targets, claim/start actions, child run links, submitted consumables, approval, and rework.
- **Architecture** — capability architecture diagrams from agent-runtime, including application diagrams and TOGAF-style collection views.
- **Governance Paths** — optional SMT formal verification for workflow governance paths, deploy/push gates, QA approvals, and Workbench promotion checks.
- **AI Causality Proof** — conservative RCA report for a run and optional subject such as a file path, commit SHA, artifact id, or incident symptom.

Key APIs:

```bash
GET http://localhost:3003/api/v1/capabilities/:id/readiness
GET http://localhost:3003/api/v1/capabilities/:id/architecture-diagram
GET http://localhost:8080/api/workflow-instances/:id/evidence-pack
GET http://localhost:8080/api/workflow-instances/:id/evidence-pack?format=markdown
GET http://localhost:8080/api/workflow-instances/:id/ai-causality-report
GET http://localhost:8080/api/work-items
```

The embedded Workbench at `http://localhost:5176` is now the **Story-to-Delivery Workbench**. A workflow-linked Workbench opens with resolved workflow values, guides the operator from story → agents → artifacts → gates → handoff, and mirrors stage outputs into normal Workgraph consumables so downstream nodes and resumed workflows can consume approved artifacts outside the Workbench session.

Capability bootstrap in agent-and-tools web (`http://localhost:3000/capabilities`) acts as a **Capability Agent Team Factory**. It previews predefined PO/Architect/Developer/QA/Security/DevOps/Governance/Verifier-style agents, marks locked governance/verifier gates, shows Git-grounded roles, and keeps generated agents or learned knowledge draft/inactive until human activation.

Agent Execution Runtime local code intelligence indexes Python, TypeScript, TSX, JavaScript, JSX, Go, and Java files from `MCP_SANDBOX_ROOT`. Agents should prefer `find_symbol`, `get_symbol`, `get_ast_slice`, and `get_dependencies` before full-file `read_file`; this keeps local/private code local while giving the model compact symbol summaries, signatures, line ranges, imports, branches, and commit evidence.

### Option C — per-app compose files

Each app still has its own `docker-compose.yml` if you want to run a subset without the master:

```bash
cd singularity-iam-service        && docker compose up -d
cd context-fabric                 && docker compose up -d
cd agent-and-tools                && docker compose up -d
cd workgraph-studio/infra/docker  && docker compose up -d   # postgres+minio+api+web
cd UserAndCapabillity             && npm install && npm run dev
cd singularity-portal             && npm install && npm run dev
```

> **Heads up:** the per-app compose files use *different* container names + ports than the master (e.g. `agentandtools-postgres` vs. `singularity-at-postgres`). Don't mix them — pick one approach and stick with it.

---

## Service inventory

| Service | URL | Auth | Notes |
|---------|-----|------|-------|
| **portal** | http://localhost:5180 | IAM JWT | the wrapper SPA — start here |
| **user-and-capability** | http://localhost:5175 | IAM JWT | IAM admin SPA |
| **workgraph-web** | http://localhost:5174 | workgraph token | Designer + Runtime UI |
| **blueprint-workbench** | http://localhost:5176 | workgraph token | Embedded staged agent workbench |
| **agent-web** | http://localhost:3000 | optional JWT | Next.js admin |
| **iam-service** | http://localhost:8100/api/v1 | bearer (login) | OpenAPI: `/docs` |
| **workgraph-api** | http://localhost:8080/api | workgraph token | DAG runtime |
| **prompt-composer** | http://localhost:3004/api/v1 | optional JWT | `/compose-and-respond` |
| **agent-runtime** | http://localhost:3003/api/v1 | optional JWT | agent templates, memory |
| **tool-service** | http://localhost:3002/api/v1 | optional JWT | tool registry, `/tools/discover`, `/tools/invoke` |
| **agent-service** | http://localhost:3001/api/v1 | optional JWT | agent CRUD |
| **context-api** | http://localhost:8000 | service token for internal routes | `/execute`, `/execute/events`, legacy `/chat/respond` |
| **llm-gateway** | http://localhost:8001 | none | `/llm/respond`, `/llm/models`, `/docs` |
| **context-memory** | http://localhost:8002 | none | `/memory/messages`, `/context/compile` |
| **metrics-ledger** | http://localhost:8003 | none | `/metrics/dashboard` |
| **iam-postgres** | localhost:5433 | `singularity / singularity` | `singularity_iam` DB |
| **at-postgres** | localhost:5432 | `postgres / singularity` | `singularity` DB (pgvector) |
| **wg-postgres** | localhost:5434 | `workgraph / workgraph_secret` | `workgraph` DB |
| **wg-minio** | http://localhost:9000 (console :9001) | `workgraph / workgraph_secret` | artifact storage |

---

## Data model

After M30 the platform owns **5 disjoint Postgres databases** (158 tables total). Each is owned by exactly one service; cross-DB references flow as opaque UUIDs at the application layer, never via SQL joins.

- **[`docs/data-model/`](docs/data-model/README.md)** — index of all 7 ERDs.
- **[`docs/data-model/00-platform-overview.md`](docs/data-model/00-platform-overview.md)** — start here. 5-DB topology graph + cross-DB UUID join-key table (which IDs flow where).
- Per-DB ERDs: [IAM](docs/data-model/01-iam.md) · [agent-runtime](docs/data-model/02-agent-runtime.md) · [composer-owned](docs/data-model/03-prompt-composer-owned.md) · [composer-runtime-read](docs/data-model/03-prompt-composer-runtime-read.md) · [workgraph](docs/data-model/04-workgraph.md) · [audit-gov](docs/data-model/05-audit-gov.md) · [tool-service](docs/data-model/06-tool-service.md)

Four of the seven diagrams are **auto-generated** by `prisma-erd-generator` on every `prisma generate`. CI's `data-model-drift` job fails red when a PR changes a Prisma schema without re-running generate.

---

## Using the platform

### Sign in

Open http://localhost:5180 → Sign in with `admin@singularity.local` / `Admin1234!`. The portal stores the IAM JWT in `localStorage` under `singularity-portal.auth` and forwards it to every backend.

### What you'll see

The portal home shows four live tiles pulling from each backend:

- **My open tasks** — counts + recent items from `workgraph /api/mcp/inbox`
- **Workflow runs** — active and recent `WorkflowInstance`s across templates
- **LLM cost & token savings** — total tokens saved + cost saved from `metrics-ledger`
- **Your capabilities** — IAM capability list filtered to the signed-in user

The sidebar's **Apps** section deep-links to:

- **Workgraph Designer** — the visual DAG editor + runtime UI
- **Agent & Tools** — agents, prompts, tools admin
- **IAM Admin** — users, roles, capabilities

> The deep-link apps each handle their own auth right now (workgraph-web has its own login). Single-sign-on across all UIs is on the roadmap (set `AUTH_PROVIDER=iam` on workgraph + change tile auth in user-and-capability).

---

## End-to-end demo

This is the wire that ships in the current build: a workflow runs, calls the composer, calls context-fabric, gets a response, persists three correlated audit records.

```bash
# 1. Bring up everything
./singularity.sh up
sleep 30   # let migrations + first builds complete

# 2. Login to workgraph-api (its own user, separate from IAM today)
TOKEN=$(curl -sS -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@workgraph.local","password":"admin123"}' | jq -r .token)

# 3. Create a workgraph Agent (workgraph's own registry)
AGENT_ID=$(curl -sS -X POST http://localhost:8080/api/agents \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Demo Agent","provider":"mock","model":"mock-fast","skillIds":[]}' | jq -r .id)

# 4. Find a seeded composer agentTemplateId (from agent-and-tools/agent-runtime seed)
TEMPLATE_ID=$(docker exec singularity-at-postgres psql -U postgres -d singularity \
  -tAc 'SELECT id FROM "AgentTemplate" LIMIT 1;' | tr -d ' ')

# 5. Build a 2-node DAG: START → AGENT_TASK → END
WF_ID=$(curl -sS -X POST http://localhost:8080/api/workflow-templates \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"E2E Demo"}' | jq -r .id)

START=$(curl -sS -X POST http://localhost:8080/api/workflow-templates/$WF_ID/design/nodes \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"nodeType":"START","label":"start","positionX":0,"positionY":0}' | jq -r .id)

AGENT_NODE=$(curl -sS -X POST http://localhost:8080/api/workflow-templates/$WF_ID/design/nodes \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"nodeType\":\"AGENT_TASK\",\"label\":\"audit\",\"positionX\":200,\"positionY\":0,
    \"config\":{
      \"agentId\":\"$AGENT_ID\",
      \"agentTemplateId\":\"$TEMPLATE_ID\",
      \"task\":\"Audit {{instance.vars.module}} for OWASP issues.\",
      \"modelOverrides\":{\"modelAlias\":\"mock\"},
      \"contextPolicy\":{\"optimizationMode\":\"medium\"},
      \"toolDiscovery\":{\"enabled\":false}
    }
  }" | jq -r .id)

END=$(curl -sS -X POST http://localhost:8080/api/workflow-templates/$WF_ID/design/nodes \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"nodeType":"END","label":"end","positionX":400,"positionY":0}' | jq -r .id)

curl -sS -X POST http://localhost:8080/api/workflow-templates/$WF_ID/design/edges \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"sourceNodeId\":\"$START\",\"targetNodeId\":\"$AGENT_NODE\",\"edgeType\":\"SEQUENTIAL\"}" > /dev/null
curl -sS -X POST http://localhost:8080/api/workflow-templates/$WF_ID/design/edges \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"sourceNodeId\":\"$AGENT_NODE\",\"targetNodeId\":\"$END\",\"edgeType\":\"SEQUENTIAL\"}" > /dev/null

# 6. Run with a Mustache var
RUN_ID=$(curl -sS -X POST http://localhost:8080/api/workflow-templates/$WF_ID/runs \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"demo run","vars":{"module":"auth-service"},"globals":{}}' | jq -r .id)

curl -sS -X POST http://localhost:8080/api/workflow-instances/$RUN_ID/start \
  -H "Authorization: Bearer $TOKEN" > /dev/null

sleep 5

# 7. Inspect the result — three correlated IDs
docker exec singularity-wg-postgres psql -U workgraph -d workgraph -tAc "
SELECT 'promptAssemblyId: ' || (\"structuredPayload\"::json->>'promptAssemblyId') ||
       E'\nmodelCallId:      ' || (\"structuredPayload\"::json->>'modelCallId') ||
       E'\ntokens_saved:     ' || (\"structuredPayload\"::json->'optimization'->>'tokens_saved')
FROM agent_run_outputs
WHERE \"runId\" IN (SELECT id FROM agent_runs WHERE \"instanceId\" = '$RUN_ID');"

# Inspect the assembled prompt in composer
ASSEMBLY_ID=$(docker exec singularity-wg-postgres psql -U workgraph -d workgraph -tAc \
  "SELECT \"structuredPayload\"::json->>'promptAssemblyId' FROM agent_run_outputs \
   WHERE \"runId\" IN (SELECT id FROM agent_runs WHERE \"instanceId\" = '$RUN_ID');" | tr -d ' ')
docker exec singularity-at-postgres psql -U postgres -d singularity -tAc \
  "SELECT \"contentSnapshot\" FROM \"PromptAssemblyLayer\" \
   WHERE \"promptAssemblyId\" = '$ASSEMBLY_ID' AND \"layerType\" = 'TASK_CONTEXT';"
# → "# Current Task\nAudit auth-service for OWASP issues."   ✓ var substituted
```

### Deploy Environment Check

For the office laptop or any remote Docker host, configure the GitHub
environment secrets used by `.github/workflows/deploy.yml`:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PATH`

On a target host, run this before using the deploy workflow:

```bash
DEPLOY_HOST=localhost DEPLOY_USER="$USER" DEPLOY_PATH="$PWD" DEPLOY_SSH_KEY_FILE=~/.ssh/id_rsa \
  ./bin/check-deploy-env.sh
```

### M25 Knowledge / Citation Check

Prompt Composer now stores typed retrieval evidence on each `PromptAssembly`
so Run Insights can show citations per agent step. Before demoing or after a
DB rebuild, verify the pgvector and citation surfaces:

```bash
PROMPT_COMPOSER_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/singularity" \
  ./bin/check-m25-knowledge.sh
```

Pass criteria:

- `vector` extension exists.
- `PromptAssembly.evidenceRefs` exists.
- `CapabilityCompiledContext` exists.
- Recent `evidenceRefs` rows stay small enough for audit replay.

### Execution Governance Surfaces

These are now implemented and should be checked during smoke tests:

- **Live streaming:** Agent Execution Runtime emits `llm.stream.delta`; Workgraph exposes
  `/api/workflow-instances/:id/events/stream`; Run Viewer and Run Insights show
  live transcript/events with polling fallback.
- **Approval resume:** Agent Execution Runtime pauses on `requires_approval` and SERVER-tool
  `waiting_approval`; Context Fabric resumes through `/execute/resume`;
  Workgraph Approvals shows paused agent tool calls, allows reason capture, and
  lets operators edit JSON tool arguments before approving.
- **Citations:** Prompt Composer writes typed `RetrievedChunk[]` evidence refs;
  Run Insights renders per-step citation drill-through.
- **Tenant guardrails:** Context Fabric can require `run_context.tenant_id` with
  `REQUIRE_TENANT_ID=true`; call logs and event rows persist `tenant_id` so
  event replay and rollups can be tenant-filtered.
- **Deploy readiness:** `.github/workflows/deploy.yml` is manual and SSH-based.
  It is active only after the GitHub environment secrets above are configured.

---

## `singularity.sh` cheatsheet

```
up [service]        start all (or just one)
down                stop everything (keeps volumes)
nuke                stop + delete all data volumes (confirms)
stop <service>      stop one service
restart <service>   restart one service
status (ps)         list services + state
logs <service>      tail logs (pass -f to follow)
build [service]     rebuild image(s)
urls                printable URL cheatsheet
ls                  list known service names
login               smoke-test IAM /auth/local/login
doctor              validate config, health, DBs, LLM keys, Agent Execution Runtime
config <command>    configure DBs, keys, endpoints, LLMs, Agent Execution Runtime
help                usage
```

---

## Architecture deep-dive

### The composition plane

`prompt-composer` (port `3004`, in the agent-and-tools workspace) is the new center of gravity. It owns the prompt-assembly tables (`PromptProfile`, `PromptLayer`, `PromptAssembly`) and exposes:

- `POST /api/v1/prompt-profiles` (CRUD)
- `POST /api/v1/prompt-layers` (CRUD)
- `POST /api/v1/prompt-assemblies` (legacy assemble — same contract as agent-runtime used to expose)
- `POST /api/v1/compose-and-respond` (the new value-add)

`/compose-and-respond` is now a direct/debug surface. Workgraph `AGENT_TASK`
uses Context Fabric `/execute`; Context Fabric calls composer in
`previewOnly=true` mode, then dispatches through the governed runtime/LLM path. A
non-preview composer call also delegates to `/execute`, not `/chat/respond`.

1. Builds a substitution context from `workflowContext` (`{{instance.vars.x}}`, `{{node.priorOutputs.y}}`, `{{capability.metadata.z}}`, `{{artifacts.<label>.excerpt}}`, `{{task}}`)
2. Loads the template's base profile + binding overlay layers
3. Adds capability context, knowledge artifacts, distilled memory layers
4. Adds workflow-phase layers
5. Builds a `TOOL_CONTRACT` layer from static grants + `tool-service /tools/discover`, with **both** JSON Schema and natural-language summary per tool
6. Renders artifacts as `ARTIFACT_CONTEXT` layers (priority 600) — supports inline `content`, pre-extracted `excerpt`, or `minioRef` (placeholder; full fetch is M4.1 work)
7. Adds `TASK_CONTEXT` (priority 900)
8. Appends node-level `EXECUTION_OVERRIDE` layers (priority 9999)
9. Sorts by priority, concatenates, hashes, persists `PromptAssembly` + `PromptAssemblyLayer` rows
10. Calls `context-fabric /execute` with the assembled `system_prompt` and `task` as `message`
11. Returns a unified response with `promptAssemblyId` plus Context Fabric/Agent Execution Runtime correlation IDs

### Workgraph wire (M5)

`apps/api/src/modules/workflow/mcp/executors/AgentTaskExecutor.ts` does the M5 plumbing:

- Reads `node.config` for `agentTemplateId`, `task`, optional `artifacts`/`overrides`/`modelOverrides`/`contextPolicy`
- Reads `instance.context._vars` and `instance.context._globals`
- Walks prior `AgentRun` outputs to populate `priorOutputs`
- POSTs to `context-fabric /execute`; Context Fabric calls `prompt-composer /compose-and-respond` in preview mode
- Persists the response on `AgentRunOutput.structuredPayload` with full correlation
- Sets `AgentRun.status = AWAITING_REVIEW` on success, `FAILED` on composer error
- Emits `AgentRunStarted`/`AgentRunCompleted`/`AgentRunFailed` outbox events

### Mental-model file

The full architecture history (5+ rounds of decisions, gap analysis, target topology, phased rollout) lives at `~/.claude/plans/in-the-singularityneonew-i-agile-fern.md`.

---

## Migration history

The composition plane was added in five milestones, each verified end-to-end:

| Milestone | What it delivered |
|-----------|-------------------|
| **M1** | Scaffolded `apps/prompt-composer` + relocated `PromptProfile`/`PromptLayer`/`PromptAssembly`/`PromptAssemblyLayer` Prisma models |
| **M2** | Mirrored prompt CRUD endpoints at parity (profiles, layers, attach, assemblies). Smoke-tested via curl against shared Postgres. |
| **M3** | Cut over the agent-and-tools admin (`web/`) to call composer instead of agent-runtime: new `/api/composer/*` Next.js rewrite, `web/Dockerfile` gained `PROMPT_COMPOSER_URL` build-arg (Next.js bakes rewrites at build time, not runtime), agent-runtime's prompt route mount removed |
| **M4** | Added `POST /compose-and-respond` — workflow context, artifacts, Mustache substitution, tool-service discovery, context-fabric call, three correlation IDs |
| **M5** | Wired workgraph's `AgentTaskExecutor` to call `/compose-and-respond`. Fixed `AgentRun.startedAt`/`completedAt` lifecycle. Fixed workgraph Dockerfile (workspace context + Alpine OpenSSL) so it actually builds and runs in production. |

---

## Phased Agent Reasoning Model (v4)

> **Status:** opt-in via two env flags. Default off — the existing flat ReAct loop continues to run for every workflow until both flags are set to `true` AND the caller requests `agentReasoningMode: "phased"`.

### Why this exists

The original `mcp-server/src/mcp/invoke.ts:runLoop()` was a free-form ReAct loop: the LLM was given a system prompt plus a tool list and was free to emit any tool call (or final text) at any step until `max_steps`. Production traces surfaced six recurring failure modes that all traced back to that unstructured shape:

1. **Lazy edits** — agents would add an enum value but skip the corresponding switch/handler/registry change; the gate only required *a* code-change receipt and *a* verification, never that the changes matched the requested implementation.
2. **Wandering exploration** — agents spent 6–14 steps re-reading files whose results had been compressed out of the sliding window.
3. **Tool-call thrashing** — agents retried `find`/`ls`/`wc` 9× before the model noticed they were rejected.
4. **Verification skipped** — agents called `finish_work_branch` before `run_test`, leaving the gate to reject the run after the fact.
5. **Plan never explicit** — the *implementation plan* lived only in the model's prose, got compressed, then disappeared.
6. **Output truncation under low `maxOutputTokens`** — `write_file` content arrived empty when the model's response stream cut off mid-stream.

Each was fixable in isolation; the shared root cause is that **the loop had no structured progression**. The v4 redesign introduces a six-phase state machine that gates which tools are visible AND dispatchable per phase, requires an explicit revisable plan artifact, enforces path-coverage between the plan's required code targets and the actual code-change paths, and validates verification commands against the verifier registry.

### The six phases

| Phase | Budget | LLM-visible AND dispatchable tools | Transition gate |
|-------|--------|------------------------------------|-----------------|
| `PLAN_DRAFT` | 2 | read-only: `find_symbol`, `get_symbol`, `get_ast_slice`, `get_dependencies`, `search_code`, `read_file`, `list_directory`, `index_workspace` | Valid plan JSON parsed (robust extractor) OR budget exhausted → fallback plan synthesized |
| `EXPLORE` | 6 | read-only (same set as `PLAN_DRAFT`) | Every required draft target file has been read OR budget exhausted |
| `PLAN_CONFIRM` | 2 | read-only | Confirmed plan JSON emitted. Dropped required targets must include a `skipReason`. |
| `ACT` | 10 | mutation + read: `replace_text`, `replace_range`, `apply_patch`, `write_file`, plus `read_file`, `search_code`, `get_symbol`, `get_ast_slice` so the agent can verify imports / inspect surrounding code while editing | All `required: true` plan items applied (path-coverage check) OR marked `skipped` with reason OR budget exhausted |
| `VERIFY` | 2 | `run_test`, `run_command`, `verification_unavailable` | A verification receipt exists; the receipt's command is validated against the verifier registry |
| `FINALIZE` | 1 | **none** — `mcp-server` auto-finishes via `buildResponseBody` emitting the `finish_work_branch_auto` audit kind | Auto-close |

Total developer budget: 2 + 6 + 2 + 10 + 2 + 1 = **23 steps**, with a hard cap of 28 for safety slack.

> `finish_work_branch_auto` is the audit/provenance label Agent Execution Runtime writes when it auto-finishes a successful run — it is **not** an LLM-callable tool. The LLM-callable tool is `finish_work_branch`; FINALIZE exposes neither so the model never has to make that choice.

### The plan artifact

A first-class JSON object produced by the model in `PLAN_DRAFT` and revised in `PLAN_CONFIRM`. The Zod schema lives in `mcp-server/src/mcp/plan.ts`:

```json
{
  "rationale": "Add containsACharacter operator end to end.",
  "targets": [
    { "file": "src/main/java/.../Operator.java",          "kind": "code", "required": true,  "intent": "add enum value",         "status": "pending" },
    { "file": "src/main/java/.../RuleEngineService.java", "kind": "code", "required": true,  "intent": "add switch case",         "status": "pending" },
    { "file": "src/test/java/.../RuleEngineServiceTest.java", "kind": "test", "required": true, "intent": "case-insensitive test", "status": "pending" },
    { "file": "README.md",                                "kind": "docs", "required": false, "intent": "document operator",       "status": "pending" }
  ],
  "verification": { "suggested": { "command": "mvn", "args": ["test"], "cwd": "." } },
  "risks": ["case sensitivity", "null/empty handling"]
}
```

Per-target fields:

- `file` — workspace-relative path
- `kind` — `"code" | "test" | "docs" | "config"`
- `required` — `true | false`; required-true items must be applied or explicitly skipped before `ACT` can exit
- `intent` — human-readable description (also used by the path-coverage gate when explaining failures)
- `status` — `"pending" | "read" | "edited" | "skipped"` (tracked in `LoopState.phaseMachine.planProgress`)
- `skipReason` — required when `status === "skipped"`; logged to audit

**Why `kind` + `required` matter.** A docs-only task will have `required: true` only on `kind: "docs"` rows, so the path-coverage gate passes naturally. A functional-code task will have `required: true` on `kind: "code"` rows, so a README-only edit fails the gate — the lazy-edit problem.

#### Robust plan-JSON extraction

LLMs almost always wrap JSON in markdown fences and pad it with conversational prose. The parser (`mcp-server/src/mcp/plan.ts:extractAndParsePlan`) handles all three common shapes:

1. Fenced \`\`\`json … \`\`\` blocks (with or without the `json` language tag)
2. Plain JSON with no fence
3. Greedy outer-brace recovery when prose surrounds the object

Validation failure does **not** abort the run — see the fallback section below.

### Tool gating: filter both visible AND dispatchable lists

The phase filter applies to two arrays in `LoopState`:

1. `availableTools` — what the LLM sees in the request's `tools` array
2. `fullToolDescriptors` — what dispatch can execute

If the model emits a tool_call for a tool not in the current phase's allowlist:

- Dispatch refuses with a structured, model-readable error such as
  > `Tool 'write_file' is not available in phase EXPLORE. Available tools this phase: find_symbol, get_ast_slice, get_dependencies, get_symbol, index_workspace, list_directory, read_file, search_code. The phase transitions to PLAN_CONFIRM after all required draft targets have been read.`
- The refusal counts as the step (so a model that ignores guidance still hits its budget)
- An `agent.phase.tool_violation` audit event records the attempt

### Path-coverage gate (the lazy-edit fix)

Three layers ensure the gate cannot be bypassed:

1. **In-loop check (ACT transition):** `runLoop` cannot leave `ACT` until `unsatisfiedRequiredTargets(plan, accumulatedCodeChangePaths, planProgress)` is empty. Skipped-with-reason counts as satisfied; required-true skips are logged but not blocked.
2. **Verifier-side check (existing):** `blueprint.router.ts:~2520` still requires a passing or explicitly-unavailable verification receipt.
3. **Post-loop check (new):** `buildResponseBody` emits `codeChangeCoverage: { required, covered, skipped, missing, hasRequiredCodeGap }` into the run result. The workgraph-api stage gate adds a branch: if `missing` contains any `kind: "code"` target, verdict = `NEEDS_REWORK` regardless of receipt status.

This is what stops `"README changed, service untouched"` from satisfying the existing gates.

### Verifier validation

The plan's `verification.suggested` is a **hint**, not a contract:

1. At `VERIFY` entry, `mcp-server` runs `detectVerifiers(workspaceRoot)` to get the canonical list from the verifier registry.
2. The model may pick from the registry OR pass the suggested command if it matches a registry entry AND passes the existing command-allowlist (`mcp-server/src/tools/command.ts:ALLOWED_COMMANDS`).
3. Otherwise the agent must call `verification_unavailable` with an explicit reason — the gate accepts this as `ACCEPTED_WITH_RISK` when the operator confirms.

### Repetition detector — phase-aware

The previous flat-loop detector tripped on the agent's natural `CONFLICT`-retry-with-new-hash recovery pattern in mid-mutation work. The phase-aware version applies different thresholds and rules per phase:

| Phase | Threshold | Tighter rule |
|-------|-----------|--------------|
| `PLAN_DRAFT`, `EXPLORE`, `PLAN_CONFIRM` | 3 | Standard (consecutive identical args) |
| `ACT` | 3 | **AND** identical OUTPUT — so a `CONFLICT`-then-retry-with-new-hash does **not** fire because the output differs |
| `VERIFY` | 2 | Verification calls are short; two identical failures = no progress |

Counters reset on:

- Successful mutation (`success: true` from a mutation tool)
- `CONFLICT` `error_code` (legit re-read incoming)
- Phase transition

### Plan fallback when `PLAN_DRAFT` runs out of budget

If the model burns both `PLAN_DRAFT` steps without emitting valid JSON, `mcp-server` synthesizes a minimal default plan with empty targets so the path-coverage check is vacuous and the agent operates in unconstrained-but-budget-enforced mode. An `agent.plan.fallback_synthesized` audit event flags the run.

### Live phase frame injected each step

Before every LLM call, `mcp-server` injects a fresh system-role frame that the sliding window cannot compress away:

```
Phase: ACT (step 4 of 10 in this phase).
Plan progress: 1/3 required targets edited, 0 skipped. Remaining: src/main/java/.../RuleEngineService.java, src/test/.../RuleEngineServiceTest.java
Allowed this phase: apply_patch, get_ast_slice, get_symbol, read_file, replace_range, replace_text, search_code, write_file.
Transition: apply every required target's edit (or mark skipped with reason) to advance to VERIFY.
```

The static "Phased Agent Contract" half of the model's instructions lives in the **Developer Role Contract** layer in prompt-composer (id `00000000-0000-0000-0000-0000000000a2`); apply via `./bin/apply-phased-agent-prompt.sh` after deploying.

### Approval pause / resume — backward compatible

`PendingApproval.phase_machine` is an optional field on the approval envelope. When present, the resumed loop re-enters the same phase with its plan, progress, budgets, step usage, and repetition counters intact. When absent (legacy envelopes minted before v4), the resume path defaults to flat-loop mode — no crashes on old approvals in flight.

### How to enable

Set both flags to `true` in `.env`:

```bash
MCP_AGENT_PHASES_ENABLED=true
WORKBENCH_AGENT_PHASES_ENABLED=true
```

Then recreate the affected containers so they pick up the env vars:

```bash
SSH_AUTH_SOCK="" docker compose up -d --no-deps --force-recreate \
  mcp-server workgraph-api context-api
```

And (one-time) apply the phased-agent prompt to prompt-composer:

```bash
./bin/apply-phased-agent-prompt.sh
```

To disable, set either flag to `false` and recreate the containers — the flat ReAct loop resumes immediately, no code rollback needed.

### How to verify it's working

After the next developer-stage run:

```bash
./bin/trace.sh --latest --stage develop
```

You should see:

- `LlmCallRecord` entries carrying a new `phase` field (`PLAN_DRAFT`, `EXPLORE`, `ACT`, …)
- Per-phase audit events: `agent.plan.drafted`, `agent.plan.revised`, `agent.phase.transitioned`
- If a tool was rejected by gating: `agent.phase.tool_violation`
- If the lazy-edit gate tripped: `agent.plan.required_code_gap`

The unit-test suite covers the pure logic:

```bash
cd mcp-server && pnpm test
# 137 passing | 2 skipped (was 67 before v4; +70 new tests)
```

### File reference

| File | Role |
|------|------|
| `mcp-server/src/mcp/phases.ts` | Phase enum, tool allowlists, transition predicates, repetition rules, code-change coverage, phase-frame synthesis, fallback-plan synthesis |
| `mcp-server/src/mcp/plan.ts` | Plan Zod schema (kind + required + status + skipReason), `extractAndParsePlan` robust JSON extractor, progress mutators, path-coverage helpers, plan-diff for revision audit events |
| `mcp-server/src/mcp/invoke.ts` | `LoopState.phaseMachine` extension, runtime helpers (`initPhaseMachine`, `applyPhaseFilteringForLlmCall`, `tryParsePlanFromAssistant`, `phaseGateForToolCall`, `recordPhaseToolEffect`, `detectPhaseRepetition`, `advancePhaseStepAndMaybeTransition`), `runLoop` integration, `buildResponseBody` coverage emission, `savePending`/`takePending` persistence |
| `mcp-server/src/config.ts` | `MCP_AGENT_PHASES_ENABLED` env flag (Zod-coerced boolean, default `false`) |
| `mcp-server/src/audit/store.ts` | `LlmCallRecord.phase` field for trace correlation |
| `mcp-server/src/audit/pending.ts` | `PendingApproval.phase_machine` field (backward compatible) |
| `mcp-server/test/{phases,plan,phase-resume}.test.ts` | 70 unit tests covering pure logic + persistence |
| `workgraph-studio/apps/api/src/modules/blueprint/blueprint.router.ts` | `WORKBENCH_AGENT_PHASES_ENABLED` opt-in, `WORKBENCH_DEVELOPER_PHASE_BUDGETS` constant, per-stage `agentReasoningMode` + `phaseBudgets` plumbed into the execute payload, `attemptCodeChangeCoverage` helper + path-coverage gate branch in the verdict check |
| `context-fabric/services/context_api_service/app/execute.py` | Plumbs `agentReasoningMode` + `phaseBudgets` from the incoming `/execute` request into the `invoke_payload.limits` block sent to mcp-server |
| `bin/apply-phased-agent-prompt.sh` | Idempotent one-shot script that PATCHes prompt-composer's Developer Role Contract layer with the static "Phased Agent Contract" section |
| `docker-compose.yml` | Env-var pass-through for `MCP_AGENT_PHASES_ENABLED` (mcp-server) and `WORKBENCH_AGENT_PHASES_ENABLED` (workgraph-api) |

The design is preserved at `~/.claude/plans/immutable-sniffing-quiche.md` for reviewers.

---

## Troubleshooting

### Two Postgres servers on `:5432`

If you have a Homebrew Postgres running on `localhost:5432` it'll shadow Docker's `at-postgres`. Symptom: clients connecting to `localhost:5432` from the host get the Homebrew DB (no Singularity tables) while clients inside the Docker network see the right one. Fix:

```bash
brew services stop postgresql@14    # or whatever version
```

(Or remap the host port for `at-postgres` in the master compose to e.g. `5435:5432`.)

### Port `5433` is taken (workgraph postgres can't start)

The IAM Postgres binds `5433`. The master compose remaps **workgraph postgres to `5434`** to avoid this. If you also run the original `workgraph-studio/infra/docker/docker-compose.yml`, edit its host port from `5433:5432` to `5434:5432`.

### Workgraph rejects the IAM JWT (you see 401s on the My-Tasks tile)

Workgraph runs `AUTH_PROVIDER=local` by default — it has its own user table and login endpoint. The portal sends the IAM JWT to all backends; workgraph 401s on it. The portal handles this gracefully (only the IAM client is "authoritative" for session — workgraph 401s show as a tile error, the user stays signed in).

To make workgraph honor IAM JWTs, set on `workgraph-api`:

```yaml
environment:
  AUTH_PROVIDER: iam
  IAM_BASE_URL: http://iam-service:8100/api/v1
  IAM_SERVICE_TOKEN: <a long-lived token from IAM>
```

Workgraph already ships an `iam/client.ts` that handles this — just hasn't been turned on.

### Prisma "OpenSSL not detected" inside Alpine

Some images are missing `libssl`. Fix in the affected `Dockerfile`:

```dockerfile
RUN apk add --no-cache openssl
```

### Vite dev says "port 5180 in use"

The master compose runs the portal in nginx on `:5180`. If you also `npm run dev` it locally, kill one or the other.

```bash
lsof -i :5180          # find the PID
kill <pid>
```

### Master compose service didn't pick up an env change

Compose only re-reads env on container creation. Use:

```bash
./singularity.sh restart <service>   # picks up env from docker-compose.yml
docker compose up -d <service>       # same
```

For portal/web env changes (Vite bakes some at build time), rebuild:

```bash
./singularity.sh build <service>
./singularity.sh restart <service>
```

### Tearing everything down

```bash
./singularity.sh down                    # stop, keep data
./singularity.sh nuke                    # stop + delete all volumes (ASKS first)
docker compose down -v --remove-orphans  # raw equivalent
```

---

## Open items

These are real gaps, not nice-to-haves:

- **SSO deployment mode** — IAM is the platform identity source. Workgraph supports `AUTH_PROVIDER=iam`; make sure deployed stacks do not leave Workgraph in local auth except for offline dev.
- **AgentRun correlation columns** — `promptAssemblyId`, `modelCallId`, `contextPackageId`, `cfCallId`, and runtime IDs are still stored in `structuredPayload` JSON. Promote to dedicated columns for faster reporting.
- **M25 production hardening** — typed citations, compiled context, and hybrid retrieval exist, but still need benchmark enforcement, FTS migration/backfill checks, and quality comparison reviews before calling it production-grade.
- **Hard tenant isolation** — tenant IDs are now propagated, persisted, and filterable. True isolation still needs tenant-scoped service tokens, row-level checks everywhere, and possibly database RLS/schema separation.
- **Observability depth** — Jaeger is available and several services have OTel, but the full Workgraph → Context Fabric → Agent Execution Runtime trace is not yet stitched as one distributed trace.
- **Deploy secrets** — Dockerfiles, CI image builds, and manual deploy workflow exist. The GitHub environment secrets must still be configured per target.

---

## Branding

The Singularity wordmark and the silver swirl mark are shared assets used by every UI in the platform. They live in **one place**:

```
branding/
├── README.md                      brand guide: colors, typography, placement rules
├── tokens.css                     CSS custom properties (--brand-forest, --brand-green, …)
├── singularity-logo.png           full lockup (drop the official PNG here)
└── singularity-mark.png           swirl-only — favicons + tight headers (optional)
```

### Drop the brand asset once, propagate everywhere

```bash
# 1. Save the official logo PNG at:
#       branding/singularity-logo.png      (full lockup)
#       branding/singularity-mark.png      (swirl-only — optional; falls back to logo)

# 2. Sync to every app's public/ directory:
./bin/sync-branding.sh

# Output:
#   ✓ synced → singularity-portal/public/
#   ✓ synced → UserAndCapabillity/public/
#   ✓ synced → agent-and-tools/web/public/
#   ✓ synced → workgraph-studio/apps/web/public/
#   ✓ 4 app(s) updated.
```

Re-run any time the canonical files change. Each app loads `/singularity-mark.png` (with `/singularity-logo.png` as a graceful fallback) from its own `public/` root, so cross-domain CORS is never a concern.

### Visual identity at a glance

| Element | Value |
|---------|-------|
| Sidebar background | forest gradient `#0E3B2D → #082821` |
| Wordmark | "Singularity" — Inter 700, tracking +0.04em, warm white `#F5F2EA` |
| Tagline | "GOVERNED AGENTIC DELIVERY" — Inter 600, tracking +0.18em, ~55% opacity |
| Primary action | green `#00843D` (hover `#006236`) |
| Active nav | green left/right border `#00A651` + 8% white background |
| Tab title | every app: `<title>Singularity — <App Name></title>` |
| Favicon | `/favicon.png` (synced from `branding/singularity-mark.png`) |

See `branding/README.md` for the full guide (typography rules, placement, prohibited usage).

---

## Repo layout

```
SingularityNeoNew/
├── docker-compose.yml          # master compose (18 services)
├── singularity.sh              # CLI wrapper
├── README.md                   # this file
├── branding/                   # canonical logo + tokens.css (one drop, all apps consume)
├── bin/
│   └── sync-branding.sh        # copies branding/*.png into each app's public/
│
├── singularity-iam-service/    # Python FastAPI — identity
├── agent-and-tools/            # TS monorepo — agents/tools/composer/runtime
│   ├── apps/
│   │   ├── agent-service/
│   │   ├── tool-service/
│   │   ├── agent-runtime/
│   │   └── prompt-composer/    # NEW (composition plane)
│   ├── packages/
│   ├── web/                    # Next.js admin
│   └── docker-compose.yml      # per-app compose (alternative to master)
├── context-fabric/             # Python — 4× FastAPI for LLM optimization
├── workgraph-studio/           # TS pnpm workspace — DAG designer + runtime
│   ├── apps/api/               # Express + Prisma
│   ├── apps/web/               # React + ReactFlow
│   ├── packages/{shared-types,engine}/
│   └── infra/docker/docker-compose.yml
├── UserAndCapabillity/         # React + Vite — IAM admin SPA
└── singularity-portal/         # NEW — wrapper SPA (this is the front door)
```

---

## License & ownership

Internal Singularity Neo platform. See per-app READMEs for component-level details:

- [UserAndCapabillity/README.md](./UserAndCapabillity/README.md)
- [context-fabric/README.md](./context-fabric/README.md)
