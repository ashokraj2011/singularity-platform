# Singularity Neo Platform

An enterprise AI-agent platform composed of six independently-deployable applications: identity, agent registry, prompt composition, LLM cost optimization, workflow orchestration, and a unified portal that wraps them all.

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
- [Using the platform](#using-the-platform)
- [End-to-end demo: workgraph DAG calls composer calls context-fabric](#end-to-end-demo)
- [`singularity.sh` cheatsheet](#singularitysh-cheatsheet)
- [Architecture deep-dive](#architecture-deep-dive)
- [Migration history (what was built)](#migration-history)
- [Troubleshooting](#troubleshooting)
- [Open items / roadmap](#open-items)

---

## What's in the box

| App | Role | Stack | Ports |
|-----|------|-------|-------|
| **singularity-iam-service** | Identity, orgs, roles, capabilities, JWT | Python · FastAPI · Postgres | `8100`, postgres `5433` |
| **agent-and-tools** | Agent definitions, tool registry, prompt assembly, agent CRUD UI | TypeScript monorepo · Express · Next.js · Prisma · Postgres+pgvector | `3000–3004`, postgres `5432` |
| **context-fabric** | LLM cost optimizer (context compaction + token-saving ledger) | Python · 4× FastAPI · SQLite | `8000–8003` |
| **UserAndCapabillity** | Visual admin SPA for IAM | React 19 · Vite · Tailwind · Radix · Zustand | `5175` |
| **workgraph-studio** | Visual DAG designer + workflow runtime | React + ReactFlow + Zustand · Express + Prisma · MinIO | `5174` (web) / `8080` (api), postgres `5434`, minio `9000-9001` |
| **singularity-portal** | The wrapper SPA — single login + dashboard tiles + deep links | React 19 · Vite · Tailwind · Radix | `5180` |

Six applications. Each owns its database. `capability_id` is the join key across them; joins happen at the application layer, never in SQL.

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
- Free host ports: `3000–3004`, `5174–5175`, `5180`, `5432–5434`, `8000–8003`, `8080`, `8100`, `9000–9001`
- Optional: `OPENROUTER_API_KEY` in `context-fabric/.env` for real LLM calls (otherwise uses `mock` provider)

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
./singularity.sh ls                        # list known service names
./singularity.sh build [service]           # rebuild image(s)
./singularity.sh help                      # full usage
```

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
| **agent-web** | http://localhost:3000 | optional JWT | Next.js admin |
| **iam-service** | http://localhost:8100/api/v1 | bearer (login) | OpenAPI: `/docs` |
| **workgraph-api** | http://localhost:8080/api | workgraph token | DAG runtime |
| **prompt-composer** | http://localhost:3004/api/v1 | optional JWT | `/compose-and-respond` |
| **agent-runtime** | http://localhost:3003/api/v1 | optional JWT | agent templates, memory |
| **tool-service** | http://localhost:3002/api/v1 | optional JWT | tool registry, `/tools/discover`, `/tools/invoke` |
| **agent-service** | http://localhost:3001/api/v1 | optional JWT | agent CRUD |
| **context-api** | http://localhost:8000 | none | `/chat/respond`, `/docs` (OpenAPI) |
| **llm-gateway** | http://localhost:8001 | none | `/llm/respond`, `/llm/models`, `/docs` |
| **context-memory** | http://localhost:8002 | none | `/memory/messages`, `/context/compile` |
| **metrics-ledger** | http://localhost:8003 | none | `/metrics/dashboard` |
| **iam-postgres** | localhost:5433 | `singularity / singularity` | `singularity_iam` DB |
| **at-postgres** | localhost:5432 | `postgres / singularity` | `singularity` DB (pgvector) |
| **wg-postgres** | localhost:5434 | `workgraph / workgraph_secret` | `workgraph` DB |
| **wg-minio** | http://localhost:9000 (console :9001) | `workgraph / workgraph_secret` | artifact storage |

---

## Using the platform

### Sign in

Open http://localhost:5180 → Sign in with `admin@singularity.local` / `Admin1234!`. The portal stores the IAM JWT in `localStorage` under `singularity-portal.auth` and forwards it to every backend.

### What you'll see

The portal home shows four live tiles pulling from each backend:

- **My open tasks** — counts + recent items from `workgraph /api/runtime/inbox`
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
      \"modelOverrides\":{\"provider\":\"mock\",\"model\":\"mock-fast\"},
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

`/compose-and-respond` is what workgraph's `AgentTaskExecutor` calls. It:

1. Builds a substitution context from `workflowContext` (`{{instance.vars.x}}`, `{{node.priorOutputs.y}}`, `{{capability.metadata.z}}`, `{{artifacts.<label>.excerpt}}`, `{{task}}`)
2. Loads the template's base profile + binding overlay layers
3. Adds capability context, knowledge artifacts, distilled memory layers
4. Adds workflow-phase layers
5. Builds a `TOOL_CONTRACT` layer from static grants + `tool-service /tools/discover`, with **both** JSON Schema and natural-language summary per tool
6. Renders artifacts as `ARTIFACT_CONTEXT` layers (priority 600) — supports inline `content`, pre-extracted `excerpt`, or `minioRef` (placeholder; full fetch is M4.1 work)
7. Adds `TASK_CONTEXT` (priority 900)
8. Appends node-level `EXECUTION_OVERRIDE` layers (priority 9999)
9. Sorts by priority, concatenates, hashes, persists `PromptAssembly` + `PromptAssemblyLayer` rows
10. Calls `context-fabric /chat/respond` with the assembled `system_prompt` and `task` as `message`
11. Returns a unified response with **three correlation IDs**: `promptAssemblyId`, `modelCallId`, `contextPackageId`

### Workgraph wire (M5)

`apps/api/src/modules/workflow/runtime/executors/AgentTaskExecutor.ts` does the M5 plumbing:

- Reads `node.config` for `agentTemplateId`, `task`, optional `artifacts`/`overrides`/`modelOverrides`/`contextPolicy`
- Reads `instance.context._vars` and `instance.context._globals`
- Walks prior `AgentRun` outputs to populate `priorOutputs`
- POSTs to `prompt-composer /compose-and-respond`
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

- **SSO** — only IAM is authoritative for the portal. Workgraph-api needs `AUTH_PROVIDER=iam` flipped on so the same IAM JWT works platform-wide.
- **Workgraph Agent table vs. agent-and-tools `AgentTemplate`** — two parallel registries today. The "mirror / federate / collapse" decision is unresolved.
- **AgentRun correlation columns** — `promptAssemblyId`, `modelCallId`, `contextPackageId` are stuffed in `structuredPayload` JSON. Promote to dedicated columns for queryability.
- **Streaming** — composer + workgraph still synchronous on `/chat/respond`. No SSE token streaming yet.
- **MCP bridge** — slated to live inside context-fabric on `:8004`; not built. Needs a per-capability MCP server registry in IAM (`mcp_servers`, `mcp_server_secrets`, `mcp_capability_bindings`).
- **Knowledge / learning pipeline** — `CapabilityCodeSymbol`/`CapabilityCodeEmbedding`/`CapabilityKnowledgeArtifact` schemas exist in agent-runtime; no symbol extractor or embedder service populates them. The `learning_candidates → learning_profiles → DistilledMemory` pipeline lacks a distillation worker + promotion UI.
- **Per-tenant multi-tenancy** — capability scoping is the soft boundary; no schema-per-tenant or hard isolation yet.
- **Observability** — no OpenTelemetry/Jaeger across the stack; correlation IDs exist but aren't wired into traces.
- **Production deploy** — the Dockerfiles work; CI/CD configs (`.github/workflows`) do not exist yet.

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
