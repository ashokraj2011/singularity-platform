# Singularity Platform

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Status: Active development](https://img.shields.io/badge/status-active-brightgreen.svg)](#)
[![Services: 11+](https://img.shields.io/badge/services-11%2B-blue.svg)](#service-inventory)

An enterprise AI-agent platform composed of independently-deployable backend services: identity, agent registry, prompt composition, LLM cost optimization, workflow orchestration, an Agent Execution Runtime, a single central LLM gateway, a federated lookup + receipt + event-bus platform layer, and one unified `platform-web` frontend.

> **Published as a monorepo**: `https://github.com/<your-org>/singularity-platform`

For the full architecture, capability, component, connection, installation, configuration, and operations guide, start with [docs/README.md](./docs/README.md), the [Singularity Platform Handbook](./docs/platform-handbook.md), or the [HTML handbook](./docs/platform-handbook.html).

---

## Quickstart — clone to demo in ~5 minutes

### Prerequisites
- Docker Desktop (Compose v2)
- `git`, `psql`; `curl` is useful for ad-hoc inspection, but the bundled doctor/smoke scripts fall back to Python HTTP checks when it is unavailable.
- Python 3.11+ for bare-metal app/runtime launchers and local Python smoke helpers. If your laptop's `python3` is 3.9.x, install Python 3.11+ and set `SINGULARITY_PYTHON=/path/to/python3.11`.
- Ports free for the default Docker stack: `5180, 8000, 8080, 8100, 5432, 5434, 9000-9001`. Optional local runtime profiles add `7100` for MCP, `8001` for llm-gateway, `8010` for formal verification, `8011` for compression, and `8500` for audit-governance.
- ~6 GB free RAM for the core stack; more if you enable local runtime/verification profiles

### 1. Clone
```bash
git clone https://github.com/<your-org>/singularity-platform.git
cd singularity-platform
```

### 2. Bring up — one command
```bash
./singularity.sh config init --profile office-laptop
./singularity.sh config mcp-catalog --default-alias mock
./singularity.sh config write
./singularity.sh up
./singularity.sh doctor
./singularity.sh topology
```

This brings up the **core stack**: IAM + consolidated `platform-core` agent/tools APIs + context-api + Workgraph-owned code generation + unified `platform-web`.

Runtime infrastructure is intentionally pluggable:

```bash
./singularity.sh up --profile llm-gateway   # add local LLM gateway
./singularity.sh up --profile mcp           # add local MCP/tool runtime
./singularity.sh up --profile audit         # add audit-governance side stack
./singularity.sh up --full                  # historical all-local stack
./singularity.sh core-only                  # stop optional/runtime containers and return to core
```

If Docker is available but Docker Compose is not desired, use the plain Docker launcher:

```bash
bin/docker-core.sh up --build        # core platform apps only, no MCP/LLM containers
bin/docker-core.sh seed
bin/docker-core.sh smoke
```

Add audit-governance with `--with-audit`. MCP and LLM Gateway stay outside this launcher and should dial into Context Fabric as separate runtimes. See [Plain Docker Deployment](./docs/plain-docker-deployment.md).

To prove the deployment options from a clean checkout, use the clone test matrix:

```bash
bin/clone-and-test-deployments.sh \
  --target /Users/ashokraj/Downloads/singularity-platform-deploy-test \
  --reset-target
```

See [Deployment Test Matrix](./docs/deployment-test-matrix.md) for pushed-clone, dirty-working-tree, bare-metal, and runtime-bridge variants. To test the two LLM execution paths (Anthropic gateway + Copilot CLI), see [Testing Copilot + Anthropic Gateways](./docs/testing-copilot-and-anthropic.md).

For platform-wide logs, trace correlation, the bare-metal log forwarder, and Datadog/Splunk export guidance, see [Observability Log Lake](./docs/observability-log-lake.md). The operator UI is `http://localhost:5180/operations/logs`; a trace-specific cockpit is `/audit/trace/<traceId>`.

In production or hybrid development, point services at remote `llm-gateway` and MCP endpoints instead of starting those profiles locally.
Operations readiness in `platform-web` separates required core services from optional runtime infrastructure. Open `/operations/readiness` to see core backend health, and the MCP/LLM Gateway/Formal Verifier/audit endpoints as local, remote, unavailable, or not configured without treating every optional runtime as a platform outage. `/foundry` is a first-class route backed by Workgraph, not a separate Code Foundry API container.

Production/staging boots are intentionally fail-closed. Use `APP_ENV=production` or `SINGULARITY_ENV=production` to activate guardrails even when dev containers keep `NODE_ENV=development`; then set `AUTH_OPTIONAL=false`, `TENANT_ISOLATION_MODE=strict`, `REQUIRE_TENANT_ID=true`, and rotate all development secrets before starting services.

For Docker-to-remote wiring, set container-reachable URLs:

```bash
MCP_SERVER_INTERNAL_URL=https://mcp.example.com
LLM_GATEWAY_INTERNAL_URL=https://llm-gateway.example.com
```

First boot pulls images + builds web bundles. Wait ~3–5 minutes. Tail with `./singularity.sh logs workgraph-api -f` if you want to watch.

> Need to bring up just one piece? `./singularity.sh up <service-name>` works for compose services (run `./singularity.sh ls` for the list). Optional side stacks come up only through their profiles.

The local configuration flow is intentionally boring:
- `.singularity/config.local.json` is the canonical local profile.
- `./singularity.sh config write` generates the per-app env files.
- Secrets stay in local ignored files, not in Platform Web or git.
- `./singularity.sh doctor` writes the masked setup report used by Platform Web `/operations`.
- Operators only choose capability, workflow, budget preset, model alias, and runtime workspace; the platform resolves the service wiring.

### 3. Apply baseline seeds
```bash
bin/seed-docker.sh
```

Seeds the full Docker demo in dependency order: IAM teams/users/capabilities, common agent baselines and capability bindings, prompt-composer profiles, Workgraph artifacts/demo workflows, SDLC workflows, and main-profile parent wrappers for workbench workflows. Re-running is safe. Doctor verifies the expected workflow set, runnable routing policies, linked workbench definitions, parent entry points, and orphan-free workbench rows.

For direct database maintenance without Docker, use `seed/apply.sh <db_user> [db_password] [db_host] [db_port]` to apply the SQL seed bundle, then run the app-specific Prisma/TypeScript seeds documented in `bin/seed-docker.sh` or the bare-metal app launcher path.

### 4. One-line smoke check
```bash
for u in \
  "http://localhost:8100/api/v1/health" \
  "http://localhost:8000/health" \
  "http://localhost:8080/health" \
  "http://localhost:5180/healthz" \
  "http://localhost:5180/" \
  "http://localhost:5180/agents/studio" \
  "http://localhost:5180/workflows"; do
  printf "%-65s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' $u)"
done
```

You should see `200` for all entries.

If you started optional local profiles, also check:

```bash
curl -s -o /dev/null -w 'llm-gateway %{http_code}\n' http://localhost:8001/health
curl -s -o /dev/null -w 'mcp-server  %{http_code}\n' http://localhost:7100/health
curl -s -o /dev/null -w 'audit-gov   %{http_code}\n' http://localhost:8500/health
SINGULARITY_DOCTOR_AUDIT_SMOKE=1 ./singularity.sh doctor  # strict DB/schema + ingest/query through Platform Web
SINGULARITY_DOCTOR_TRACE_SPINE=1 ./singularity.sh doctor  # trace_id evidence across Context Fabric, composer, MCP, audit
```

### 5. The demo path — five clicks, five "wow" moments

Start from the unified Platform Web app at `http://localhost:5180/`. It is the operator shell for Agent Studio, Workflows, Workbench, Foundry, IAM, and Operations. Context Fabric, the Agent Execution Runtime, and the LLM Gateway remain separate runtime services behind that shell.

Platform Web exposes first-class routes under `localhost:5180` so operators can stay in one app:
`/operations`, `/agents`, `/agents/studio`, `/workflows`, `/runs`, `/work-items`, `/workbench`, `/foundry`, and `/identity`.

| Step | URL | What to show |
|---|---|---|
| **1. Login** | `http://localhost:5180/identity` | Login with the bootstrap IAM account from `./singularity.sh config show`, then verify with `./singularity.sh login`. IAM is the source of truth for teams, roles, and capability memberships. |
| **2. Agent Studio** | `http://localhost:5180/agents/studio` → pick the seeded capability from the dropdown | Show the four **Locked** common baselines (Architect / Developer / QA / Governance), click **Derive →** on one, name it. Mention: "derived agents inherit prompt profile + tool policy, become editable by capability owners, audit-gov captures `agent.template.derived`" |
| **3. Run a workflow** | `http://localhost:5180/workflows` → click **Run a Workflow** → pick "Business Initiative Delivery" → start | The new run lands in `/runs/<id>`. Open a HUMAN_TASK node, attach a file, click Complete. Workflow advances. |
| **4. Run Insights** | Click the green **Insights →** pill at the top of the run viewer | The M24 dashboard — total duration, per-step Gantt with precise timing (`startedAt`/`completedAt` columns), artifacts list, cost-by-model, full audit timeline keyed to the run. Mention: "every step duration is authoritative, not inferred" |
| **5. Governance & cost** | `./singularity.sh up --profile audit`, then `http://localhost:5180/audit` and `/cost` | Optional local audit-governance side stack. Show the recent `agent.template.derived`, `cf.execute.completed`, `tool.execution.success`, `llm.call.completed` rows. Then `/cost` for $$ + tokens, with model breakdown. Mention: "the runtime producers — Agent Execution Runtime (`mcp-server`), workgraph-api, agent-service (agents + tools), context-fabric, agent-runtime — fire fire-and-forget events here; pre-flight budget/rate-limit checks happen inline." |

### 6. Optional polish for the demo

- **Set a tight budget then watch DENIED**:
  ```bash
  ./singularity.sh up --profile audit
  curl -s -X POST http://localhost:8500/api/v1/governance/budgets \
    -H 'content-type: application/json' \
    -H 'authorization: Bearer <audit-service-token>' \
    -d '{"scope_type":"capability","scope_id":"<cap-id>","period":"day","tokens_max":1}'
  ```
  Re-run any AGENT_TASK on that capability — `status:DENIED` returns instantly, no LLM dispatch. Open `/audit` → see `governance.denied` event.
- **Agent Execution Runtime smoke** (MCP is optional/remote-capable; this checks the supported runtime surface when you start it locally):
  ```bash
  ./singularity.sh up --profile mcp
  curl -fsS -H 'authorization: Bearer demo-bearer-token-must-be-min-16-chars' \
    http://localhost:7100/healthz/strict
  SINGULARITY_DOCTOR_DEEP_SMOKE=1 ./singularity.sh doctor
  ```
- **Insights for a workflow that calls an LLM**: design a workflow with an AGENT_TASK, point it at a derived agent, run. Insights will populate `cost_usd` + `tokens` + model breakdown for real.

### 7. Tear down
```bash
./singularity.sh down     # stop stacks, keep data volumes
./singularity.sh nuke     # stop + WIPE all data volumes (asks for confirmation)
```

### URLs cheat sheet (print these)

```
Platform Web            http://localhost:5180    unified operator shell
Platform routes         http://localhost:5180/operations
                        http://localhost:5180/agents
                        http://localhost:5180/agents/studio
                        http://localhost:5180/workflows
                        http://localhost:5180/runs
                        http://localhost:5180/work-items
                        http://localhost:5180/workbench
                        http://localhost:5180/foundry
                        http://localhost:5180/identity

Workgraph API            http://localhost:8080
Agent Runtime API        http://localhost:3003
Agent Service API        http://localhost:3001    agents + tools (tool-service merged in)
Prompt Composer API      http://localhost:3004
Context Fabric API       http://localhost:8000
Agent Execution Runtime               http://localhost:7100
IAM API                  http://localhost:8100/api/v1
Audit & Governance API   http://localhost:8500  (--profile audit or remote)
```

### Known gotchas (fix before the demo)

1. **First boot of agent-runtime fails seed** if `pgvector` extension isn't created. The compose's `at-postgres` is a pgvector image so this is usually OK; if you see `type "vector" does not exist` after a force-reset:
   ```bash
   docker exec agentandtools-postgres psql -U postgres -d singularity -c "CREATE EXTENSION IF NOT EXISTS vector;"
   ```
2. **Token errors after a long idle**: IAM tokens expire. Re-login through `http://localhost:5180/identity` and refresh the current page.
3. **Port collisions** — `lsof -i :5180` if Platform Web will not start; another stack from a previous demo might still be holding it.
4. **Context Fabric crashes with `Read-only file system: '/data'` and Platform Web never comes up**: pull the latest repo so Context API uses Postgres or the writable app-local fallback instead of legacy `/data` SQLite paths.
   For bare-metal:
   ```bash
   git pull
   bin/bare-metal-apps.sh down
   bin/bare-metal-apps.sh up <db_user> [db_password] [db_host] [db_port]
   tail -f logs/context-api.log logs/platform-web.log
   ```
   For Docker:
   ```bash
   git pull
   docker compose build context-api platform-web
   docker compose --profile core up -d --force-recreate context-api platform-web
   docker compose logs -f context-api platform-web
   ```

The narrative to lead with: *"Singularity is a governed agent platform — every agent is rooted in a locked baseline, every workflow run is observable end-to-end, and every LLM call is gated against a budget."*

---

## Per-component adoption (M65)

The platform is monorepo-shipped but operators can adopt subsets:

```bash
docker compose --profile core         up -d   # core product stack; default via .env COMPOSE_PROFILES=core
docker compose --profile llm-gateway  up -d   # local gateway if not using a remote gateway
docker compose --profile mcp          up -d   # local MCP/tool runtime if not using a remote runtime
COMPOSE_PROFILES=backend-split docker compose up -d   # debug with split agent/tools backend containers
COMPOSE_PROFILES=gateway-only docker compose up -d     # gateway + shared Postgres only
COMPOSE_PROFILES=composer-only docker compose up -d    # prompt-composer + gateway + shared Postgres
docker compose --profile full         up -d   # historical all-local stack
```

Plain Docker without Compose is also supported for the core platform apps:

```bash
bin/docker-core.sh up --build [--with-audit]
bin/docker-core.sh seed [--with-audit]
bin/docker-core.sh smoke [--with-audit]
```

That path intentionally excludes MCP and LLM Gateway. Run those as dial-in runtimes with `bin/laptop-bridge.sh`, `bin/bare-metal-runtime.sh`, or a remote deployment.

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

For dev machines that already have Postgres and do not want Docker. The bare-metal path is split into two launchers: `bin/bare-metal-apps.sh` starts the platform apps, and `bin/bare-metal-runtime.sh` starts only local `llm-gateway` plus `mcp-server` when you want those deployable runtime services on the same machine. The apps launcher runs real IAM, agent-and-tools services, Workgraph API, audit-governance, context-api, and the unified Platform Web app on `:5180`; it expects MCP/LLM to be remote, laptop-hosted, or started separately. Context Fabric stores run on Postgres (DB `singularity_context_fabric`), matching the Docker stack. It skips metrics-ledger (sunset; savings moved to audit-gov), MinIO, and legacy split frontend apps.

Bare-metal Python services require Python 3.11+. The launchers prefer `SINGULARITY_PYTHON`, then `python3.12`, `python3.11`, and finally `python3` if it is new enough. If an office laptop reports an error such as `singularity-iam-service requires a different python: 3.9.6`, install Python 3.11+ and retry; any stale repo-local `.venv` created with Python 3.9 is rebuilt automatically.

```bash
brew install python@3.11
SINGULARITY_PYTHON="$(brew --prefix python@3.11)/bin/python3.11" bin/bare-metal-apps.sh up <db_user> [db_password] [db_host] [db_port]
```

### Simplest — the interactive wizard

```bash
bin/setup.sh        # asks Postgres + LLM, then brings everything up, seeds, smoke-checks, prints URLs
bin/setup.sh --yes  # non-interactive: reuse saved answers (.singularity/setup.conf) or defaults
```

It wraps everything below — collects a few answers once, runs the stack, optionally points the LLM gateway at an OpenAI-compatible bridge (Copilot etc.), and remembers your answers for next time.

### Or run the split stack scripts directly

```bash
bin/bare-metal-apps.sh up <db_user> [db_password] [db_host] [db_port]
bin/bare-metal-apps.sh smoke      # check platform app /health and pages
BARE_METAL_DEEP_SMOKE=1 bin/bare-metal-apps.sh smoke  # route/API/browser parity + audit/Workbench/workflow/Foundry/Agent Studio lifecycle checks
BARE_METAL_TRACE_SPINE=1 bin/bare-metal-apps.sh smoke  # also verify trace_id evidence across runtime stores
bin/bare-metal-apps.sh status     # list platform app PIDs
bin/bare-metal-apps.sh logs workgraph-api    # tail one platform app service
bin/bare-metal-apps.sh down       # stop platform apps + free platform ports

bin/bare-metal-runtime.sh up      # optional local llm-gateway + mcp-server
bin/bare-metal-runtime.sh smoke   # check :8001 and :7100
bin/bare-metal-runtime.sh down    # stop only local runtime infra
```

Idempotent — re-runs of `up` skip installs and DB creation if they already happened, just re-boots. `bin/bare-metal.sh` remains as a compatibility all-in-one launcher; prefer the split scripts for normal work. Defaults: `db_password` from `$PGPASSWORD` env or `postgres`, `db_host=localhost`, `db_port=5432`.

The launchers free only Singularity-owned app/runtime ports before boot. Storage ports (`5432`, `5434`, `9000`, `9001`) are never killed. Legacy/debug UI ports (`5174`, `5175`, `5176`, `5181`, `5182`, `8085`) are swept by default to clear old split-web processes; set `SINGULARITY_FREE_LEGACY_PORTS=0` if another local app owns one of those ports. Platform Web runs on `:5180`; the launcher also clears a stale repo-owned Next dev listener on `:3000` from older scripts, but leaves unrelated `:3000` processes alone. Smoke checks allow guarded `401/403` JSON responses on auth-protected Platform Web API proxies, and give Next dev UI routes enough time for first-request compilation.

### Blue Workbench cockpit

The blue Blueprint Workbench cockpit now runs **in-process** as Platform Web's `/workbench` route — same origin (`:5180`), so the auth token carries and a CALL_WORKFLOW "Open Workbench" launch opens the blue cockpit directly. `/workbench` *is* the blue cockpit and handles all views internally; the old `/workbench/<view>` native console was removed. The `blueprint-workbench` cockpit (and the `workgraph-web` pages) are now compiled into Platform Web as library source rather than standalone apps, so the standalone `:5176` vite server and the `:8085` `edge-gateway` are no longer needed for the workbench. Just open `http://localhost:5180/workbench`. (The `:8085` `edge-gateway` Docker service remains only as an optional legacy/debug multi-app gateway; see [`edge-gateway/README.md`](edge-gateway/README.md).)

Runtime bridge and Platform Web proxy tokens are also bootstrapped for local bare-metal runs. `bin/bare-metal-runtime.sh up` and the compatibility all-in-one path first reuse `SINGULARITY_RUNTIME_TOKEN`, `SINGULARITY_DEVICE_TOKEN`, or `.singularity/laptop-device-token`; expired/invalid file tokens are discarded. When IAM is reachable, they auto-mint a 90-day `kind=runtime` MCP token through `/auth/device-token` using the configured local admin credentials and save it with `0600` permissions. The app launcher also mints a local `platform-web` service JWT and writes it to `WORKGRAPH_PROXY_SERVICE_TOKEN` plus `PROMPT_COMPOSER_SERVICE_TOKEN` in `.env.local`, so Workgraph and Prompt Composer server-side proxy calls do not show missing deployment-boundary secrets in Operations. Set `SINGULARITY_AUTO_MINT_RUNTIME_TOKEN=false` or `SINGULARITY_AUTO_MINT_PLATFORM_WEB_TOKEN=false` to disable either automatic mint.

The bare-metal path applies the same full seed bundle as Docker: SQL seeds, agent-runtime baseline templates, prompt-composer profiles, Workgraph demo artifacts/workflows, SDLC workflows, and main-profile parent wrappers for workbench workflows. Use `seed/apply.sh` only when you deliberately want the SQL-only portion.

The manual recipe below is what the script does under the hood — useful if you want to step through it or diverge.

### 1. Postgres prep — one shot
Adjust user/password to match your instance (defaults: `postgres@localhost:5432`).

```bash
psql postgres <<'SQL'
CREATE DATABASE singularity;
CREATE DATABASE singularity_composer;
CREATE DATABASE workgraph;
CREATE DATABASE audit_governance;
CREATE DATABASE singularity_iam;
CREATE DATABASE singularity_context_fabric;
\c singularity
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\c singularity_composer
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\c singularity_context_fabric
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
export DATABASE_URL_COMPOSER="postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/singularity_composer"
export DATABASE_URL_RUNTIME_READ="$DATABASE_URL_AGENT_TOOLS"
export WORKGRAPH_APP_DB_USER="workgraph_app"
export WORKGRAPH_APP_DB_PASSWORD="workgraph_app_secret"
export DATABASE_URL_WORKGRAPH_ADMIN="postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/workgraph"
export DATABASE_URL_WORKGRAPH_RUNTIME="postgresql://${WORKGRAPH_APP_DB_USER}:${WORKGRAPH_APP_DB_PASSWORD}@${PG_HOST}:${PG_PORT}/workgraph"
export DATABASE_URL_WORKGRAPH="$DATABASE_URL_WORKGRAPH_RUNTIME"
export DATABASE_URL_AUDIT_GOV="postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/audit_governance"
export DATABASE_URL_CONTEXT_FABRIC="postgresql://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/singularity_context_fabric"
export CONTEXT_FABRIC_DATABASE_URL="$DATABASE_URL_CONTEXT_FABRIC"

# Shared JWT secret (32+ chars — workgraph-api enforces)
export JWT_SECRET="dev-secret-change-in-prod-min-32-chars!!"

export AUTH_PROVIDER="iam"
export IAM_BASE_URL="http://localhost:8100/api/v1"
export IAM_SERVICE_URL="http://localhost:8100"

# Cross-service URLs
export AUDIT_GOV_URL="http://localhost:8500"
export PROMPT_COMPOSER_URL="http://localhost:3004"
export AGENT_RUNTIME_URL="http://localhost:3003"
# tool-service was merged into agent-service; tools are served on :3001 too
export TOOL_SERVICE_URL="http://localhost:3001"
export AGENT_SERVICE_URL="http://localhost:3001"
export CONTEXT_FABRIC_URL="http://localhost:8000"
# Normal execution uses the Runtime Bridge. Direct MCP HTTP is debug fallback.
export RUNTIME_HTTP_FALLBACK_ENABLED="false"
export MCP_SERVER_URL="http://localhost:7100"
export MCP_BEARER_TOKEN="demo-bearer-token-must-be-min-16-chars"

# LLM gateway runs beside MCP; MCP serves model-run frames through it.
export LLM_GATEWAY_URL="http://localhost:8001"
export WORKBENCH_DEFAULT_MODEL_ALIAS="mock"
EOF

source .env.local
```

### 3. Install + push schemas (one-time)
```bash
( cd agent-and-tools          && npm install )
( cd workgraph-studio         && pnpm install )
( cd singularity-code-foundry && npm install )
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
  && DATABASE_URL="$DATABASE_URL_WORKGRAPH_ADMIN" npx prisma db push --skip-generate \
  && psql "$DATABASE_URL_WORKGRAPH_ADMIN" -v ON_ERROR_STOP=1 -q -f prisma/migrations/20260619123000_tenant_rls_policy_scaffold/migration.sql \
  && DATABASE_URL="$DATABASE_URL_WORKGRAPH_ADMIN" npx prisma generate )

# Workgraph runtime should use a non-bypass application DB role.
psql "$DATABASE_URL_WORKGRAPH_ADMIN" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${WORKGRAPH_APP_DB_USER}') THEN
    CREATE ROLE ${WORKGRAPH_APP_DB_USER} LOGIN PASSWORD '${WORKGRAPH_APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSE
    ALTER ROLE ${WORKGRAPH_APP_DB_USER} LOGIN PASSWORD '${WORKGRAPH_APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END\$\$;
GRANT CONNECT ON DATABASE workgraph TO ${WORKGRAPH_APP_DB_USER};
GRANT USAGE ON SCHEMA public TO ${WORKGRAPH_APP_DB_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${WORKGRAPH_APP_DB_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${WORKGRAPH_APP_DB_USER};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${WORKGRAPH_APP_DB_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${PG_USER} IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${WORKGRAPH_APP_DB_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${PG_USER} IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${WORKGRAPH_APP_DB_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${PG_USER} IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO ${WORKGRAPH_APP_DB_USER};
SQL
```

### 4. Boot + seed

Use the launcher unless you specifically need to debug one command at a time. It pushes schemas, runs the app-level seeds, starts real IAM, waits for `/api/v1/health`, applies the SQL seed bundle, then starts the rest of the demo services.

```bash
bin/bare-metal-apps.sh up postgres postgres localhost 5432
# Optional local runtime infra on this same machine:
bin/bare-metal-runtime.sh up
```

### 5. Smoke check
```bash
for url in \
  http://localhost:8100/api/v1/health \
  http://localhost:8500/health \
  http://localhost:8000/health \
  http://localhost:8080/health \
  "http://localhost:5180/api/runtime/agents/templates?scope=common&limit=3" \
  http://localhost:5180/ \
  http://localhost:5180/agents/studio \
  http://localhost:5180/workflows \
  http://localhost:5180/foundry \
  ; do
  printf "%-65s %s\n" "$url" "$(curl -s -o /dev/null -w '%{http_code}' "$url")"
done
```

All entries should return `200`. Open `http://localhost:5180` for Platform Web, `http://localhost:5180/agents/studio` for Agent Studio, `http://localhost:5180/workflows` for workflows, `http://localhost:5180/workbench` for Blueprint Workbench, and `http://localhost:5180/foundry` for Code Foundry. IAM login uses the bootstrap account shown by `./singularity.sh config show`; `./singularity.sh login` verifies it without printing the password.

Upgrading from the retired standalone Code Foundry API: run `bin/migrate-code-foundry-to-workgraph.sh` once after `./singularity.sh up`. It copies old `singularity_codegen` runs, artifacts, gaps, patch tasks, verification rows, and receipts into Workgraph, hydrates artifact file content when the old workspace files still exist, and skips duplicates on rerun.

If you started local runtime infra, those endpoints should also respond:

```bash
curl -s -o /dev/null -w 'llm-gateway %{http_code}\n' http://localhost:8001/health
curl -s -o /dev/null -w 'mcp-server  %{http_code}\n' http://localhost:7100/health
```

### Tear down
```bash
bin/bare-metal-runtime.sh down
bin/bare-metal-apps.sh down
# Optional — wipe data:
psql postgres -c "DROP DATABASE IF EXISTS singularity; DROP DATABASE IF EXISTS singularity_composer; DROP DATABASE IF EXISTS workgraph; DROP DATABASE IF EXISTS audit_governance; DROP DATABASE IF EXISTS singularity_iam; DROP DATABASE IF EXISTS singularity_context_fabric; DROP DATABASE IF EXISTS singularity_codegen;"
```

### What's intentionally skipped

| Skipped | Impact |
|---|---|
| `llm-gateway`, `mcp-server` unless `bin/bare-metal-runtime.sh up` is used | Platform remains available, but model/tool execution is expected to use remote or laptop runtime endpoints |
| context-memory, metrics-ledger | None — context-api owns the current routes; metrics savings moved to audit-gov |
| MinIO | File uploads return 5xx; insights, Agent Studio, audit, cost all still work |
| legacy split UIs (`:5182`, `:5174`, `:5175`, `:5176`, `:5181`, `:8085`) | Not started by default; Platform Web on `:5180` covers the normal path |

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
| **M11 follow-up** OTel + Jaeger | Auto-instrumentation in workgraph-api (TS), context-api (Python), tool-service (TS), agent-runtime (TS), agent-service (TS); Jaeger all-in-one in `platform-registry` compose; Workgraph explicitly injects W3C `traceparent` and `x-singularity-trace-id` on Context Fabric calls | Single trace `1cc8ef8ac9a1207b` had **59 spans across 4 services**. UI: `http://localhost:16686` |
| **M11 follow-up** Service-token auto-mint | IAM `POST /api/v1/auth/service-token` + workgraph + cf bootstrap + `IAM_BOOTSTRAP_USERNAME/PASSWORD` env. Replaces 60-min admin-JWT-passing-via-env. | Both services start with `IAM_SERVICE_TOKEN=""`, mint 30-day tokens on first call |
| **M11 follow-up / M33 hardened** Central LLM gateway | `context-fabric/services/llm_gateway_service` is the only provider-calling service. Agent Execution Runtime, Workgraph, Prompt Composer, Agent Runtime, and Context Memory send `model_alias` requests to `LLM_GATEWAY_URL`. | Missing non-mock provider config fails closed. `ALLOW_CALLER_PROVIDER_OVERRIDE=false` by default. The only implicit fallback is explicit mock mode. |
| **M42.7** Phased Agent Reasoning Model (v4) | Replaces the flat ReAct loop in mcp-server with an opt-in 6-phase state machine (`PLAN_DRAFT → EXPLORE → PLAN_CONFIRM → ACT → VERIFY → FINALIZE`). Per-phase tool allowlists, robust plan JSON extraction, path-coverage gate (lazy-edit fix), phase-aware repetition detection, backward-compatible approval pause/resume. See [Phased Agent Reasoning Model](#phased-agent-reasoning-model-v4) below. | Flip `MCP_AGENT_PHASES_ENABLED=true` + `WORKBENCH_AGENT_PHASES_ENABLED=true` in `.env`. `pnpm --filter @singularity/mcp-server test`: 137/139 passing (was 67; +70 new). `./bin/trace.sh --latest --stage develop` shows phase transitions. |

---

```
                         Platform Web (:5180)
                                  │
       ┌──────────────────────────┼──────────────────────────┐
       ▼                          ▼                          ▼
 IAM Service                Agent & Tools              Workgraph API
  (:8100)        ┌─prompt-composer (:3004)─┐              (:8080)
                 │  agent-runtime  (:3003) │                 │
                 │  agent-service  (:3001) │                 │
                 │   (agents + tools)      │                 │
                 └─────────────────────────┘                 │
                              │                              │
                              ▼                              │
                    Context Fabric (:8000)                   │
                    llm-gateway (:8001)                      │
                    memory      (:8002)                      │
                                                             │
              shared IAM JWT and platform policy gates ──────┘
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
| **singularity-iam-service** | Identity, orgs, teams, roles, capabilities, skills, JWT, Agent Execution Runtime registry, service-token mint, event bus | Python · FastAPI · Postgres | `8100`, shared postgres `5432` (`singularity_iam`) |
| **agent-and-tools** | Agent definitions, tool registry, prompt assembly, unified Platform Web UI; per-service event bus + OTel | TypeScript monorepo · Express · Next.js · Prisma · Postgres+pgvector | `3001–3004`, `5180` web, postgres `5432` |
| **context-fabric** | Context Fabric execution API, context optimization, runtime bridge, receipts, and governed orchestration | Python · FastAPI · Postgres | `8000`; optional sidecars use `8001`, `8010`, `8011` |
| **mcp-server** | MCP runtime relay. Customer-deployed, owns local tools/AST/branches, dials into Context Fabric at `/api/runtime-bridge/connect`, and forwards `model-run` frames to its local/colocated LLM gateway. Direct HTTP `7100` is debug fallback. Ships with an opt-in [Phased Agent Reasoning Model](#phased-agent-reasoning-model-v4) behind `MCP_AGENT_PHASES_ENABLED`. | TypeScript · Express · WebSocket | `7100` debug; outbound runtime bridge |
| **workgraph-studio** | Visual DAG designer + workflow runtime, Blueprint Workbench stage loop, federated `/api/lookup/*`, snapshot layer, unified `/api/receipts`, event bus + receiver, OTel | React + ReactFlow + Zustand · Express + Prisma · MinIO | `8080` API, postgres `5434`, minio `9000-9001`; UI routes live under Platform Web |
| **platform-registry** | Service + Contract Registry: every service self-registers on startup with capabilities + OpenAPI/event/node contracts | TypeScript · Express · Postgres | `8090`, postgres `5435` |
| **jaeger** (observability) | All-in-one OTel trace UI; receives spans from all instrumented services | docker image | `16686` (UI), `4317`/`4318` (OTLP) |

11 production services. Each owns its database. `capability_id` is the join key across them; joins happen at the application layer, never in SQL.

---

## The five planes

A useful mental model when deciding "which app should this feature live in?" — match the responsibility to its plane.

```
┌───────────────────────────────────────────────────────────┐
│ CONTROL          IAM + Platform Web                       │
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
- Free host ports: `3001–3004`, `5180`, `5432`, `5434`, `8000`, `8080`, `8100`, `9000–9001`. Optional local runtime profiles add `7100`, `8001`, `8010`, `8011`, and `8500`. Ports `5182`, `5174–5176`, `5181`, and `8085` are only needed for local/legacy frontend debugging.
- Optional: explicit central LLM gateway provider config. Fresh local setup is mock-only; office setup is Copilot-only.

### Option A — master compose (one shot)

```bash
cd /path/to/SingularityNeoNew
docker compose up -d                       # builds + starts the core stack
docker compose ps                          # see what's running
```

Then open **http://localhost:5180** and log in with the bootstrap IAM account shown by `./singularity.sh config show`.

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
./singularity.sh up                        # start core
./singularity.sh up --profile llm-gateway  # core + local LLM gateway
./singularity.sh up --profile mcp          # core + local MCP/tool runtime
./singularity.sh up --full                 # historical all-local stack
./singularity.sh backend-split             # debug: split agent/tools backend containers
./singularity.sh up --profile gateway-only # gateway + shared Postgres only
./singularity.sh up --profile composer-only # composer + gateway + shared Postgres only
./singularity.sh core-only                 # return to consolidated core
./singularity.sh up platform-web           # start just the unified frontend
./singularity.sh status                    # ps
./singularity.sh topology                  # explain/count the active platform containers
./singularity.sh urls                      # color-coded URL cheatsheet
./singularity.sh logs workgraph-api -f     # follow logs
./singularity.sh restart platform-core
./singularity.sh stop platform-web
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

Use `./singularity.sh config ...` when you need one place to manage the platform knobs that otherwise live across app-specific `.env` files. The v1 model is **hybrid local-first**: the canonical profile is `.singularity/config.local.json`, generated env files are written from it, and secrets stay on the laptop. Platform Web `/operations` shows the latest `./singularity.sh doctor` summary and never asks you to paste provider keys into the browser.

It configures:

- Database URLs for IAM, agent-and-tools, and Workgraph.
- IAM endpoints, with pseudo-IAM kept only as an explicit development helper.
- Service endpoints for Workgraph, prompt-composer, context-fabric, agent-runtime, agent-service (agents + merged tools), and Agent Execution Runtime.
- LLM provider policy and model aliases for the central gateway. Provider policy lives in `.singularity/llm-providers.json`; secrets are passed only to the `llm-gateway` service.
- Office-safe Copilot-only mode. `./singularity.sh config office-copilot-only` blanks OpenAI/OpenRouter/Anthropic/Ollama access in canonical config and generated env files, writes Copilot-only provider and model catalog files, and fences the gateway to the Copilot provider.
- Default/local Agent Execution Runtime URL, bearer token, public URL, sandbox root, AST index path, and local work-branch defaults. The Agent Execution Runtime does **not** need to belong to a capability; capability-specific Agent Execution Runtime registration is advanced-only.
- Git push credentials for approved WorkItem branches. The canonical config stores only mode, remote name, token env name, or SSH key path; it never stores a token or key body. The Agent Execution Runtime is the only service that receives Git push credentials.
- Gateway-owned model aliases. Workflows choose aliases; Agent Execution Runtime forwards aliases and receives resolved provider/model in receipts.
- Balanced token budget defaults. Workgraph owns run budgets, Prompt Composer owns layer/retrieval budgeting, Context Fabric enforces execution limits, and the central gateway owns provider/model routing.
- Governed artifact fetch for prompt assembly. Prompt Composer can fetch bounded text from Workgraph document-backed refs through `WORKGRAPH_ARTIFACT_FETCH_URL` using `WORKGRAPH_ARTIFACT_FETCH_TOKEN`; required artifacts fail closed if only a missing/unreadable ref is provided. In strict tenant mode, Workgraph also requires `X-Tenant-Id` and `WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS`, and rejects arbitrary MinIO object-key fetches that cannot be tied back to a tenant-owned document.
- Optional formal verification. `formalVerification.enabled` maps to `FORMAL_VERIFICATION_ENABLED`; the default is `false`, so governance path controls are disabled/skipped unless an operator explicitly enables the SMT verifier.
- UI env files for the unified `platform-web` app; legacy split UI env files are generated only for debug/backward compatibility.

Common commands:

```bash
./singularity.sh config init --profile office-laptop
./singularity.sh config interactive
./singularity.sh config office-copilot-only
./singularity.sh config mcp --base-url http://localhost:7100 --sandbox-root /path/to/repo
./singularity.sh config git --mode ssh --ssh-key ~/.ssh/id_ed25519 --remote origin
./singularity.sh config git --mode token --token-env GITHUB_TOKEN --remote origin
./singularity.sh config mcp-catalog --default-alias mock
./singularity.sh config rotate-secrets
./singularity.sh config rotate-secrets --provider-manifest-key-id local-dev
./singularity.sh config rotate-secrets --include-bootstrap-password
./singularity.sh config production-guardrails --tenant-id legacy-local
./singularity.sh config prepare-production --tenant-id <tenant-id> --dry-run
./singularity.sh config reset-bootstrap-password
./singularity.sh config mint-workgraph-proxy-token
./singularity.sh config providers
./singularity.sh config models
./singularity.sh config show
./singularity.sh doctor
./singularity.sh doctor git
./singularity.sh doctor secrets
./singularity.sh tenant-isolation
./singularity.sh config export
```

`show` masks secrets. `doctor` checks the canonical config, env drift, common ports, reachable service URLs, provider key presence, runtime token length, model-catalog readiness, Git push readiness, and secret guardrails. `doctor git` focuses on workspace writability, remote, Git identity, and auth presence. `doctor secrets` scans tracked files for local-only config, credentialed remotes, provider keys, GitHub tokens, bearer tokens, JWT-like tokens, and private-key blocks. It also checks ignored local env files for duplicate keys, production-class deployments using development defaults, and credentials placed in broad root env files instead of narrower runtime-specific secret files. Use `config prepare-production --tenant-id <tenant>` before shared/staging/production deployment to apply strict tenant guardrails and rotate deploy secrets with signed provider manifests; start with `--dry-run` to print the exact sequence without changing files. Because secret rotation changes `JWT_SECRET`, the command intentionally defers `WORKGRAPH_PROXY_SERVICE_TOKEN` minting until IAM is restarted with the generated env; after that, rerun `config prepare-production --tenant-id <tenant> --skip-rotate-secrets` to mint the tenant-scoped `platform-web` service JWT and run deploy preflight. Use `config rotate-secrets` when you only need to replace development JWT, service, runtime, MCP bearer/runner, and MCP tool-grant signing defaults in `.singularity/config.local.json` and generated env files; add `--provider-manifest-key-id <id>` to create a trusted provider-manifest HMAC key and require signed external manifests. Provider manifests and URL document sources are SSRF-guarded by default; keep `AGENT_SOURCE_ALLOW_PRIVATE_URLS=false` outside deliberate local development. Production guardrails set Workgraph, Context Fabric, and direct MCP governance defaults to `fail_closed`, enable Context Fabric tool-grant minting, require MCP grant verification with `MCP_TOOL_GRANT_MODE=enforce`, and require MCP effective capability snapshots with `MCP_REQUIRE_EFFECTIVE_CAPABILITIES=true`; deploy preflight also requires `AUDIT_GOV_URL` and verifies audit-governance `/health` because fail-closed governance must not start without a reachable ledger. Keep `TOOL_GRANT_SIGNING_SECRET` identical anywhere Context Fabric and MCP are deployed separately. `WORKGRAPH_PROXY_SERVICE_TOKEN` is intentionally not generated by `rotate-secrets`; mint it with `config mint-workgraph-proxy-token` as a `platform-web` IAM service JWT before production deploy because Platform Web uses it as a Bearer token for Workgraph API routes. Use `config production-guardrails --tenant-id <tenant>` for the guardrail-only lower-level step. Bootstrap admin password rotation is opt-in with `--include-bootstrap-password`; for an existing IAM database, recreate `iam-service` with the new env and then run `./singularity.sh config reset-bootstrap-password` to update the stored local credential hash. Doctor writes the masked operations report consumed by Platform Web `/operations`. For bare-metal runs, use `config export` to print shell exports without editing files.
`doctor` also runs `bin/check-compose-profiles.sh`, which validates every supported compose profile and the laptop/remote overlays so install paths like `backend-split`, `composer-only`, and `deprecated` cannot silently drift. The machine-readable topology source is `docs/platform-topology.json`; `bin/check-platform-topology-contract.py` validates that contract against Docker Compose and the operator docs before `bin/check-platform-topology.py` uses the same contract to verify the live Docker shape: one `platform-web`, one `platform-core` for the agent/tools APIs, the required product APIs/storage, the completed Postgres bootstrap one-shots, no running legacy frontend containers, and no mixed split/consolidated agent-tools plane. It also runs `bin/check-agent-tools-topology.sh` to ensure the agent/tools plane is either the consolidated `platform-core` container or the complete split debug set, never a mixed or partial topology. `bin/check-workgraph-tenant-guards.py` verifies strict tenant guard coverage for Workgraph runtime/admin/internal surfaces, tenant-scoped service-token contracts, and an explicit tenant-policy classification for every mounted Workgraph API route. `bin/check-workgraph-db-tenant-isolation.py` verifies the Workgraph tenant database posture: the workflow/run-snapshot tenant spine, tenant-index presence, runtime child-row connectivity, tenant RLS policy scaffold, app-role RLS-bypass posture, and, when production preflight requires it, non-null tenant data plus forced RLS on tenant-sensitive tables. `bin/check-workgraph-forced-rls-cutover.py` verifies the guarded cutover script remains non-mutating in dry-run mode, refuses apply without strict-runtime confirmation, and runs both preflight and postflight RLS checks. `bin/check-workgraph-forced-rls-enforcement.py` is enabled by `SINGULARITY_DOCTOR_DEEP_SMOKE=1` or `SINGULARITY_DOCTOR_RLS_ENFORCEMENT_SMOKE=1`; it creates a throwaway DB and non-bypass role, applies the real cutover, and proves cross-tenant reads/writes are blocked. `bin/check-m25-benchmarks.sh` verifies the DB-free M25 retrieval benchmark contract for hybrid ranking, FTS/vector fallback retention, citation markers, excerpt bounds, confidence clamping, recency boost, and capsule task-signature stability. Platform Web has two default guards: `bin/check-platform-web-routes.py` verifies canonical pages, legacy redirects, and sidebar surfaces, while `bin/check-platform-api-parity.py` verifies canonical and legacy API proxy families return parseable JSON instead of raw upstream HTML/text errors. For the stronger install audit, run `SINGULARITY_DOCTOR_DEEP_SMOKE=1 ./singularity.sh doctor`; it enables the headless Chrome UI parity check plus workflow, Workbench, Foundry, Agent Studio source-backed profile lifecycle checks. The bare-metal equivalent is `BARE_METAL_DEEP_SMOKE=1 bin/bare-metal-apps.sh smoke`; it runs the same route/API proxy/browser hydration parity checks before the mutating lifecycle smokes. You can still run individual checks: `SINGULARITY_DOCTOR_UI_SMOKE=1` verifies Workgraph templates/designer/Planner/Inbox/runs, Eval Curation, Workbench, Operations readiness, Agent Studio source-backed skill creation, Prompt Workbench, Foundry, Singularity Engine, Identity, and Variables hydrate in Chrome. `SINGULARITY_DOCTOR_LIFECYCLE_SMOKE=1` creates a temporary workflow through Platform Web, patches it, writes a tiny START -> END design graph, starts it from a WorkItem, verifies child run completion and WorkItem submission, verifies run delete/archive compatibility, approves and archives the WorkItem, then archives the workflow. `SINGULARITY_DOCTOR_WORKBENCH_SMOKE=1` creates a temporary Workbench session through Platform Web, patches runtime settings, writes and reads stage chat, then abandons the session. `SINGULARITY_DOCTOR_FOUNDRY_SMOKE=1` validates a service spec, generates a temporary run through Platform Web, reads artifacts/file content, and fetches the receipt without calling LLM patching. For local audit-governance side-stack parity, run `python3 bin/check-audit-governance-lifecycle.py`, or set `SINGULARITY_DOCTOR_AUDIT_SMOKE=1` after `./singularity.sh up --profile audit`; it verifies strict DB/schema health, ingests an event through Platform Web, queries it back, and confirms persistence. `SINGULARITY_DOCTOR_AGENT_PROFILE_SMOKE=1` logs in through IAM, creates a temporary DRAFT profile through Platform Web with local, URL-document, and provider-manifest bindings, verifies stored source-governance summary, read-only defaults/provider-lock clamping, and failed-closed provider resolution, then archives the profile. `SINGULARITY_DOCTOR_TRACE_SPINE=1` runs `bin/test-trace-spine.sh` to prove one `trace_id` reaches Context Fabric, prompt composer, MCP resource views, and audit-governance; it expects local/host-reachable MCP and the split Postgres container.

After Workgraph and Context Fabric are configured for strict tenant runtime
(`TENANT_ISOLATION_MODE=strict` and `REQUIRE_TENANT_ID=true`), run the guarded
tenant DB cutover. Dry-run is the default; `--apply` performs tenant-spine
backfill, applies the RLS policy scaffold, forces RLS, and runs postflight
checks through the non-bypass runtime app role:

```bash
./singularity.sh config prepare-production --tenant-id <tenant-id> --dry-run
./singularity.sh config prepare-production --tenant-id <tenant-id>
./singularity.sh recreate iam-service
./singularity.sh config prepare-production --tenant-id <tenant-id> --skip-rotate-secrets
./singularity.sh tenant-isolation
./singularity.sh tenant-isolation --default-tenant-id <legacy-tenant> --apply --confirm-strict-runtime
bin/check-deploy-env.sh --env-file <release-env>
```

Rows that cannot infer a tenant from stored runtime context require an explicit
`--default-tenant-id <legacy-tenant>` selected by the operator. The lower-level
break-glass scripts remain available as `bin/backfill-workgraph-tenant-ids.py`
and `bin/enable-workgraph-forced-rls.py`.

The production Workgraph app DB role must not be `SUPERUSER` and must not have
`BYPASSRLS`; `bin/check-workgraph-db-tenant-isolation.py --require-rls` fails
closed if it can bypass row security.
Production-class deploy preflight requires the forced-RLS check by default.
Set `WORKGRAPH_DB_TENANT_ISOLATION_REQUIRED=false` only for a documented and
verified alternate database isolation model. Disabling the forced-RLS check now
also requires `WORKGRAPH_DB_TENANT_ISOLATION_ALTERNATE_MODEL` set to
`schema-per-tenant`, `database-per-tenant`, or `cluster-per-tenant`, plus
`WORKGRAPH_DB_TENANT_ISOLATION_EVIDENCE` pointing to the ticket, runbook, or
architecture record that proves the alternate isolation is deployed.

The first command is a dry run. The second only writes tenant IDs that can be
inferred from stored runtime context. The third is for rows that cannot be
inferred, and requires the operator to choose the tenant that should own old
demo/imported data.

Git push credential boundary:

- Default is disabled: `GIT_PUSH` nodes preserve branch/commit evidence and block with `GIT_AUTH_MISSING`.
- SSH mode mounts only the selected key path or SSH agent socket into `mcp-server`, read-only.
- Token mode passes only the selected env var value, such as `GITHUB_TOKEN`, into Agent Execution Runtime. Tokens are not written to `.singularity/config.local.json`.
- Production grant enforcement routes Workgraph `GIT_PUSH` through Context Fabric operational grants before MCP can run `finish_work_branch`; Context Fabric signs only when the workflow has an approved gate.
- Agent Execution Runtime redacts credentialed remotes, GitHub PATs, provider keys, bearer tokens, private keys, and token-shaped values before returning output, writing audit events, or creating receipts.
- Workgraph shows `COMMITTED_NOT_PUSHED` when the local commit exists but publishing failed; use `Retry push` after fixing credentials so Workbench does not rerun.

Office laptop / local runtime setup:

```bash
bin/runtime-install.sh
singularity-runtime enroll --url https://platform.example --code <one-time-code> \
  --context-fabric-url https://context.example
export GITHUB_TOKEN=github_pat_...
export ANTHROPIC_API_KEY=sk-ant-...
singularity-runtime configure --default-provider anthropic
singularity-runtime doctor
singularity-runtime start
```

The runtime token is created by IAM through a short-lived browser enrollment
code and stored in the OS credential store. Copilot uses the governed MCP
`copilot_execute` path; it is not configured as an LLM Gateway provider. See
[Singularity Runtime Distribution](docs/singularity-runtime.md).

### Runtime Bridge and LLM gateway configuration

Normal workflow execution is WebSocket-first. MCP runtimes dial into Context Fabric at `/api/runtime-bridge/connect`; Context Fabric sends `tool-run`, `model-run`, and `code-context` frames to the selected runtime. LLM Gateway stays behind MCP in v1: MCP receives `model-run` and forwards it to its local or colocated `LLM_GATEWAY_URL`.

Direct `MCP_SERVER_URL` and direct `LLM_GATEWAY_URL` from Context Fabric are diagnostics/debug compatibility only. Enable them with `RUNTIME_HTTP_FALLBACK_ENABLED=true`. See [Runtime Dial-In Fabric](docs/runtime-dial-in-fabric.md).

For the office/cloud split where the cloud server runs the platform apps as
standard bare-metal processes and the laptop runs MCP plus LLM Gateway, use the
[Bare-Metal Cloud With Laptop MCP and LLM runbook](docs/bare-metal-cloud-laptop-runtime.md).

`context-fabric/services/llm_gateway_service` owns provider/model routing. MCP passes model aliases to its local/colocated gateway; only the gateway can hold provider credentials or open provider URLs. Raw provider/model caller overrides are disabled by default with `ALLOW_CALLER_PROVIDER_OVERRIDE=false`.

For a node that must bypass both MCP and the LLM Gateway, set
`llmRoute: "context_fabric_direct"` on an `AGENT_TASK`. Context Fabric then
calls the configured Anthropic/OpenAI/OpenAI-compatible provider itself. This
is an explicit exception to the normal gateway boundary: the node may carry a
provider, model, base URL, and credential *environment-variable name*, but
never a secret. The named credential must be in
`CONTEXT_FABRIC_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS`; custom provider URLs also
require `CONTEXT_FABRIC_DIRECT_LLM_ALLOW_CUSTOM_BASE_URLS=true`. Direct mode is
LLM-only and exposes only the governed phase-submission tool, so MCP tools are
not silently reachable from this route. Run receipts label it
`context-fabric-direct`.

The gateway bounds provider timing knobs at startup. Invalid numeric values such
as `UPSTREAM_TIMEOUT_SEC=bad` fall back to safe defaults; extreme retry delay or
sleep values are clamped so a provider outage cannot accidentally park a runtime
for hours.

The gateway reads two local JSON files:

- `.singularity/llm-providers.json` — provider policy: allowlist, default provider/model, base URLs, credential env names, and enabled/disabled flags.
- `.singularity/llm-models.json` — approved workflow-facing model aliases. Workflows choose aliases; the gateway resolves aliases to real providers/models.

Malformed model-catalog rows are ignored with warnings exposed from
`/llm/models`; duplicate aliases keep the first valid row. Invalid or unsafe
price fields make estimated cost `null` instead of breaking the request path.

These generated files are intentionally ignored by git because they are local setup state. Checked-in examples live under:

- `mcp-server/examples/llm-providers.default.json`

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

#### Route the gateway through GitHub Copilot — `bin/llm-use-copilot.sh`

For MCP, switch the **LLM Gateway**, not MCP itself. Normal model traffic flows through the runtime fabric:

```text
Context Fabric -> Runtime Bridge WebSocket -> MCP runtime -> LLM_GATEWAY_URL -> LLM Gateway -> provider
```

Once the gateway default provider is `copilot`, MCP-backed `model-run` frames use Copilot automatically.

`bin/llm-use-copilot.sh` flips **every** model alias through Copilot via the gateway, and back. It edits `llm-providers.json` (adds + enables a `copilot` provider, makes it the default), repoints **all** aliases in `llm-models.json` to `copilot/<model>` (so `claude-*`/`gpt-4o` aliases route to Copilot too), writes `COPILOT_TOKEN` to `.env.llm-secrets`, then restarts the gateway and verifies. It auto-detects deployment and works for **both** — bare-metal (restarts the `uvicorn` process on `:8001` via the repo-root `.env.local` plus `.pids.runtime` from `bin/bare-metal-runtime.sh`, with legacy `.pids` fallback) and Docker (recreates the `singularity-llm-gateway` container). Originals are backed up to `*.copilot-bak`; `--restore` reverts.

> **Prerequisite (fresh clone):** `.singularity/llm-providers.json` + `llm-models.json` are gitignored, so generate them and bring a stack up *before* running this — `./singularity.sh config init --profile office-laptop && ./singularity.sh config mcp-catalog --default-alias mock && ./singularity.sh up` (Docker). For bare-metal, just run `bin/setup.sh`: it generates config, brings the stack up, **and** points the gateway at your Copilot bridge in one step (you don't call this script yourself).

Two ways to point at Copilot:

```bash
# 1) Local OpenAI-compatible Copilot bridge (default) — e.g. `copilot-api` on :4141.
#    Bare-metal (bridge on the host):
bin/llm-use-copilot.sh --base-url http://localhost:4141/v1 --model gpt-4o --token copilot-local
#    Docker (container reaches the host bridge via host.docker.internal):
bin/llm-use-copilot.sh --base-url http://host.docker.internal:4141/v1 --model gpt-4o --token copilot-local

# 2) GitHub-hosted models — preset fills the URL + a default model. Needs a GitHub PAT
#    with the `models` permission (Bearer-only, works with the gateway as-is):
bin/llm-use-copilot.sh --preset github-models --token <GITHUB_PAT>

# Revert to the pre-Copilot config:
bin/llm-use-copilot.sh --restore
```

If the runtime pieces were already running, restart them so MCP uses the refreshed gateway config:

```bash
bin/laptop-bridge.sh gateway
bin/laptop-bridge.sh mcp
```

Verify the active provider/model catalog and the runtime bridge connection:

```bash
curl -s http://localhost:8001/llm/providers | jq
curl -s http://localhost:8001/llm/models | jq
source .env.local
curl -s -H "X-Service-Token: $CONTEXT_FABRIC_SERVICE_TOKEN" http://localhost:8000/api/runtime-bridge/status | jq
```

> For the **bare-metal** stack, the interactive wizard `bin/setup.sh` asks for the bridge URL/model/token and runs this for you (choose the *bridge* LLM option).

Flags:

| Flag | Purpose |
|------|---------|
| `--base-url <U>` | OpenAI-compatible base URL; used as `<base-url>/chat/completions`. From Docker, host servers are `http://host.docker.internal:<port>/v1`. |
| `--model <m>` | Model the endpoint exposes (`gpt-4o`, `claude-3.7-sonnet`, `openai/gpt-4o`, …). |
| `--token <T>` | Written to `.env.llm-secrets` as `COPILOT_TOKEN`. Falls back to `$COPILOT_TOKEN`, else placeholder `copilot-local` (fine if the bridge ignores auth). |
| `--preset copilot-bridge\|github-models\|copilot-editor` | Shortcut for a known endpoint. `github-models` → `https://models.github.ai/inference` (default model `openai/gpt-4o`, **PAT required**). `copilot-editor` → `https://api.githubcopilot.com` (see caveat). Explicit `--base-url`/`--model` still win. |
| `--skip-preflight` | Skip the OpenAI-compatibility reachability probe (`GET <base-url>/models`). Auto-set by `--preset github-models`. |
| `--restore` | Restore the previous config from `*.copilot-bak`. |

Verify:

```bash
curl -s http://localhost:8001/llm/providers | python3 -m json.tool    # default_provider=copilot, copilot ready
curl -s http://localhost:7100/llm/providers | python3 -m json.tool    # Agent Execution Runtime (mcp-server)
```

Caveats:

- **Bridge must be OpenAI-compatible.** The GitHub Copilot CLI `copilot --headless` is *not* an OpenAI-compatible HTTP server — the preflight rejects it. Use an OpenAI-compatible Copilot bridge (e.g. `copilot-api`).
- **`github-models` needs a real PAT** (a GitHub token with the `models` permission); the placeholder won't authenticate.
- **`copilot-editor` (`api.githubcopilot.com`)** also needs `Editor-Version` / `Copilot-Integration-Id` headers the `openai_compat` adapter does not yet send — it will likely 400/403 without a small adapter change. Prefer the bridge or `github-models`.
- Related: `./singularity.sh config office-copilot-only` generates a full Copilot-only office config; this script is the imperative "flip everything to Copilot now" path used by `bin/setup.sh`.

### Optional governance path analyzer

Formal verification is a platform-level feature toggle, off by default:

```bash
./singularity.sh config set formalVerification.enabled true
./singularity.sh config write
./singularity.sh restart formal-verifier workgraph-api platform-web
```

When disabled, Workgraph formal-analysis endpoints return `FORMAL_VERIFICATION_DISABLED`, Policy Check nodes using `engine=formal_verifier` are marked skipped with an audit receipt, and no solver call is made. When enabled, `formal-verifier` exposes `/health`, `/healthz/strict`, and `/api/v1/verification/verify`, and Platform Web Operations shows **Governance Paths** for workflow/run analysis.

### Operator command center and guided delivery

Platform Web Operations (`http://localhost:5180/operations`) is the command center for day-to-day governed delivery:

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

The Workbench route at `http://localhost:5180/workbench` is the **Story-to-Delivery Workbench**. A workflow-linked Workbench opens with resolved workflow values, guides the operator from story → agents → artifacts → gates → handoff, and mirrors stage outputs into normal Workgraph consumables so downstream nodes and resumed workflows can consume approved artifacts outside the Workbench session.

Capability bootstrap in Platform Web (`http://localhost:5180/capabilities`) acts as a **Capability Agent Team Factory**. It previews predefined PO/Architect/Developer/QA/Security/DevOps/Governance/Verifier-style agents, marks locked governance/verifier gates, shows Git-grounded roles, and keeps generated agents or learned knowledge draft/inactive until human activation.

Agent Execution Runtime local code intelligence indexes Python, TypeScript, TSX, JavaScript, JSX, Go, and Java files from `MCP_SANDBOX_ROOT`. Agents should prefer `find_symbol`, `get_symbol`, `get_ast_slice`, and `get_dependencies` before full-file `read_file`; this keeps local/private code local while giving the model compact symbol summaries, signatures, line ranges, imports, branches, and commit evidence.

### Option C — per-app compose files

Each app still has its own `docker-compose.yml` if you want to run a subset without the master:

```bash
cd singularity-iam-service        && docker compose up -d
cd context-fabric                 && docker compose up -d
cd agent-and-tools                && docker compose up -d
cd workgraph-studio/infra/docker  && docker compose up -d   # postgres+minio+api+web
cd agent-and-tools/web            && npm install && PORT=5180 npm run dev
```

Platform Web's npm scripts honor `PORT`; bare-metal uses `PORT=5180`. If an old checkout left a Next dev server on `:3000`, `bin/bare-metal-apps.sh up` clears it only when the listener belongs to this repo's `agent-and-tools/web` directory.

> **Heads up:** the per-app compose files use *different* container names + ports than the master (e.g. `agentandtools-postgres` vs. `singularity-at-postgres`). Don't mix them — pick one approach and stick with it.

---

## Service inventory

| Service | URL | Auth | Notes |
|---------|-----|------|-------|
| **platform-web** | http://localhost:5180 | IAM JWT | unified UI for operations, agents, workflows, workbench, foundry, and identity |
| **platform-core** | http://localhost:3001,3003,3004 | optional JWT | one Docker container hosting agent-service (agents + tools), agent-runtime, and prompt-composer |
| **iam-service** | http://localhost:8100/api/v1 | bearer (login) | OpenAPI: `/docs` |
| **workgraph-api** | http://localhost:8080/api | workgraph token | DAG runtime, Workbench, WorkItems, and `/api/codegen` |
| **prompt-composer** | http://localhost:3004/api/v1 | optional JWT | `/compose-and-respond`, served by `platform-core` |
| **agent-runtime** | http://localhost:3003/api/v1 | optional JWT | agent templates, memory, served by `platform-core` |
| **agent-service** | http://localhost:3001/api/v1 | optional JWT | agent CRUD plus the merged tool registry (`/api/v1/agents` and `/api/v1/tools`, including `/tools/discover` and `/tools/invoke`); served by `platform-core`. tool-service was merged here, so there is no separate `:3002` |
| **context-api** | http://localhost:8000 | service token for internal routes | `/execute`, `/execute/events`, legacy `/chat/respond` |
| **llm-gateway** | http://localhost:8001 | none | `/llm/respond`, `/llm/models`, `/docs` |
| **context-memory** | http://localhost:8002 | none | `/memory/messages`, `/context/compile` (optional/profile) |
| **at-postgres** | localhost:5432 | `postgres / singularity` | `singularity`, `singularity_iam`, `singularity_composer`, `singularity_context_fabric`; legacy `singularity_codegen` only for old Foundry imports |
| **iam-postgres** | localhost:5433 | `singularity / singularity` | deprecated profile only; do not seed this for the default stack |
| **wg-postgres** | localhost:5434 | `workgraph / workgraph_secret` | `workgraph` DB, including workflow and Foundry code-generation evidence |
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

Open http://localhost:5180 → sign in with the bootstrap IAM account shown by `./singularity.sh config show`. Platform Web stores the IAM session locally and forwards the bearer token to backend API clients.

### What you'll see

The Platform Web home shows domain entry points and health-backed operations surfaces pulling from backend services:

- **My open tasks** — counts + recent items from `workgraph /api/mcp/inbox`
- **Workflow runs** — active and recent `WorkflowInstance`s across templates
- **LLM cost & token savings** — total tokens saved + cost saved from `metrics-ledger`
- **Your capabilities** — IAM capability list filtered to the signed-in user

The sidebar's **Apps** section deep-links to:

- **Workgraph Designer** — the visual DAG editor + runtime UI
- **Agent & Tools** — agents, prompts, tools admin
- **IAM Admin** — users, roles, capabilities

> Legacy split UIs are debug-only. The normal product path uses one local session in Platform Web and internal Next navigation.

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
environment secrets listed in `docs/deploy-required-secrets.json`. Check the
GitHub Environment before a release; this verifies secret names without reading
secret values:

```bash
python3 ./bin/check-github-environment-secrets.py \
  --repo <owner>/<repo> \
  --github-environment production
```

For release env files, run the same manifest check locally:

```bash
python3 ./bin/check-github-environment-secrets.py --env-file .env.production
```

For external SSO targets, add `--require-oidc` so the OIDC secret names are
also required:

```bash
python3 ./bin/check-github-environment-secrets.py \
  --repo <owner>/<repo> \
  --github-environment production \
  --require-oidc
```

On a target host, run this before using the deploy workflow:

```bash
DEPLOY_HOST=localhost DEPLOY_USER="$USER" DEPLOY_PATH="$PWD" DEPLOY_SSH_KEY_FILE=~/.ssh/id_rsa \
  ./bin/check-deploy-env.sh
```

This check now validates more than SSH transport. It loads the shell
environment, local env files, and `.singularity/config.local.json`, then fails
closed unless production-class deployments have `APP_ENV` or `SINGULARITY_ENV`
set to `production`, `staging`, or `perf`, `AUTH_OPTIONAL=false`,
`TENANT_ISOLATION_MODE=strict`, `REQUIRE_TENANT_ID=true`, signed provider
manifests, and rotated 32+ character service tokens for Platform Web, Workgraph,
Context Fabric, MCP, and audit-governance. Use `--config-only`
for CI checks that only validate the deploy config contract, and reserve
`--allow-dev` for throwaway remote Docker hosts.

### M25 Knowledge / Citation Check

Prompt Composer now stores typed retrieval evidence on each `PromptAssembly`
so Run Insights can show citations per agent step. Before demoing or after a
DB rebuild, verify both the composer-owned citation tables and the runtime-read
retrieval tables:

```bash
# Inside the Docker network, for example from singularity-at-postgres or platform-core:
PROMPT_COMPOSER_DATABASE_URL="postgresql://postgres:singularity@at-postgres:5432/singularity_composer" \
PROMPT_RUNTIME_DATABASE_URL="postgresql://postgres:singularity@at-postgres:5432/singularity" \
  ./bin/check-m25-knowledge.sh
```

If you run it from the host and Docker owns `localhost:5432`, replace
`at-postgres` with `127.0.0.1`. If another local Postgres owns host port `5432`,
run the check inside the Docker network instead. Use `--strict-data` after
seed/backfill when you also want to require non-empty evidence and retrieval
rows.

`./singularity.sh doctor` also runs the DB-free M25 retrieval benchmark contract
through `bin/check-m25-benchmarks.sh`. Run it directly when editing retrieval
primitives:

```bash
./bin/check-m25-benchmarks.sh
```

Pass criteria:

- `vector` extension exists.
- `PromptAssembly.evidenceRefs`, `compiledContextId`, and trace columns exist.
- `CapabilityCompiledContext` exists with its unique task-signature index.
- Runtime knowledge and memory tables have pgvector HNSW indexes.
- Runtime knowledge and memory tables have generated `content_tsv` columns and
  GIN indexes for the FTS branch of hybrid retrieval.
- Recent `evidenceRefs` rows stay small enough for audit replay.
- Retrieval benchmark contract proves hybrid RRF ranking, FTS-only and
  vector-only fallback retention, bounded citation excerpts, confidence
  clamping, recency boost behavior, and capsule task-signature stability.

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
  `REQUIRE_TENANT_ID=true`; Workgraph `AGENT_TASK` dispatch also fails before
  calling Context Fabric when `TENANT_ISOLATION_MODE=strict` and no
  `tenantId`/`tenant_id` is available from node config, workflow context,
  vars/globals, or WorkItem input. Workflow instances now persist a first-class
  `tenantId`; strict-mode workflow-instance routes require the caller's
  `X-Tenant-Id`/`tenant_id` to match, and pending-execution polling is scoped
  before returning client work. Runtime artifact and approval surfaces use the
  same strict tenant guard. Service tokens minted through IAM carry `tenant_ids`
  when `IAM_SERVICE_TOKEN_TENANT_IDS` is configured, and strict Workgraph /
  Context Fabric service-token resolvers reject tokens whose claim does not
  exactly match the configured tenant scope. Workgraph internal static-token
  surfaces require `WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS` plus `X-Tenant-Id` in
  strict mode, and global feature-flag reads become admin-only. Call logs and
  event rows persist `tenant_id` so event replay and rollups can be
  tenant-filtered.
- **Deploy readiness:** `.github/workflows/deploy.yml` is manual and SSH-based.
  It is active only after the GitHub environment secrets above are configured.

---

## `singularity.sh` cheatsheet

```
up [--profile p] [service]
                    start core by default, optional profiles on demand
up --full           start the historical all-local stack
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
5. Builds a `TOOL_CONTRACT` layer from static grants + agent-service `/tools/discover` (the merged tool registry), with **both** JSON Schema and natural-language summary per tool
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
- Persists indexed correlation fields on `AgentRun` and full replay detail on `AgentRunOutput.structuredPayload`
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

### Port `5433` is taken

The default stack does not need `5433`; IAM now uses the shared `at-postgres` on `5432` with DB `singularity_iam`. Port `5433` is only used by the deprecated standalone `iam-postgres` profile or older per-app Workgraph compose files. If you run `workgraph-studio/infra/docker/docker-compose.yml` directly, edit its host port from `5433:5432` to `5434:5432` or stop the conflicting process.

### Workgraph rejects the IAM JWT (you see 401s on the My-Tasks tile)

Workgraph can run with its local auth provider in older/debug topologies. The unified Platform Web path expects Workgraph to use IAM-aware service calls and shared session handling; if Workgraph rejects IAM JWTs, set `AUTH_PROVIDER=iam` on `workgraph-api`.

To make workgraph honor IAM JWTs, set on `workgraph-api`:

```yaml
environment:
  AUTH_PROVIDER: iam
  IAM_BASE_URL: http://iam-service:8100/api/v1
  IAM_SERVICE_TOKEN: <a long-lived token from IAM>
```

Workgraph already ships an `iam/client.ts` that handles this — just hasn't been turned on.

### External SSO / OIDC Mode

IAM supports a generic OIDC deployment mode for external identity providers:

```bash
IAM_AUTH_MODE=oidc
OIDC_ISSUER_URL=https://idp.example.com/oauth2/default
OIDC_CLIENT_ID=singularity-platform
OIDC_CLIENT_SECRET=<rotated 32+ char secret>
OIDC_REDIRECT_URI=https://platform.example.com/identity/oidc/callback
```

Useful checks:

```bash
curl http://localhost:8100/api/v1/auth/providers
curl http://localhost:8100/api/v1/auth/oidc/login-url
```

Platform Web starts the OIDC redirect from `/identity/login` and completes it at
`/identity/oidc/callback`. IAM exchanges the authorization code through
`POST /api/v1/auth/oidc/code-login`, verifies the returned `id_token` and nonce,
upserts the federated IAM user, and returns the normal Singularity bearer token.
`POST /api/v1/auth/oidc/token-login` remains available for trusted non-browser
clients that already hold an IdP `id_token`.
Production deploy preflight fails closed if `IAM_AUTH_MODE=oidc` is missing
issuer/client/secret/redirect settings, uses non-HTTPS URLs, or has a weak OIDC
client secret.

### Prisma "OpenSSL not detected" inside Alpine

Some images are missing `libssl`. Fix in the affected `Dockerfile`:

```dockerfile
RUN apk add --no-cache openssl
```

### Platform Web says "port 5180 in use"

The master compose runs `platform-web` on `:5180`. If you also run `PORT=5180 npm run dev` locally, kill one or the other.

```bash
lsof -i :5180          # find the PID
kill <pid>
```

If bare-metal logs mention `address already in use :::3000`, pull the latest scripts. Older Platform Web npm scripts hardcoded `next dev -p 3000`; current scripts honor `PORT=5180`, and the launcher clears stale repo-owned `:3000` listeners from that older behavior.

### Master compose service didn't pick up an env change

Compose only re-reads env on container creation. Use:

```bash
./singularity.sh restart <service>   # picks up env from docker-compose.yml
docker compose up -d <service>       # same
```

For Platform Web env changes, rebuild:

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

- **SSO deployment mode** — IAM is the platform identity source. Workgraph supports `AUTH_PROVIDER=iam`, production/staging deploy preflight fails if Workgraph leaves IAM auth, and IAM now has a fail-closed `IAM_AUTH_MODE=oidc` path with provider readiness, authorization URL generation, server-side authorization-code exchange, verified OIDC `id_token` plus nonce login, Platform Web callback/session UX, and federated user mapping. Remaining work is provider-specific OAuth adapters for non-OIDC providers such as GitHub OAuth.
- **M25 production hardening** — typed citations, compiled context, hybrid retrieval, FTS DDL/backfill repair, fail-closed DB readiness, and a doctor-enforced retrieval benchmark contract exist. Remaining work is live corpus quality comparison reviews before calling it production-grade.
- **Hard tenant isolation** — tenant IDs are now propagated, persisted on workflow instances and browser run snapshots, filterable, required for Workgraph `AGENT_TASK` -> Context Fabric dispatch, and enforced on Workgraph workflow-instance/pending-execution routes in strict mode. Strict mode also guards Workgraph run-adjacent AgentRun, ToolRun, approval, consumable, document, code-change, receipt, insight, evidence-pack, runtime inbox, Workbench definitions, internal artifact-fetch, and feature-flag surfaces. IAM service-token minting now carries `tenant_ids`, Workgraph/Context Fabric strict-mode service-token resolvers reject broad/mismatched tokens, deploy preflight requires `IAM_SERVICE_TOKEN_TENANT_IDS` plus `WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS`, `bin/check-workgraph-tenant-guards.py` prevents known route/service-token guards plus the full Workgraph route tenant-policy ledger from silently regressing, and `bin/check-workgraph-db-tenant-isolation.py` now fails production preflight when live Workgraph data is not tenant-scoped. Workgraph also has request-scoped tenant DB context helpers, a Prisma transaction proxy, workflow-instance spine, run snapshots, AgentRun, ToolRun, approval, consumable, document, code-change, receipt, insight/evidence, runtime inbox, Workbench definitions, and internal artifact-fetch routes using tenant-scoped DB transactions, checked-in RLS policy scaffolding, a runtime-spine backfill tool, and a guarded `bin/enable-workgraph-forced-rls.py` cutover. High-assurance isolation still needs forced RLS enabled in each production target, or a move to schema-per-tenant isolation.
- **Observability depth** — Jaeger is available, several services have OTel, and Workgraph now explicitly propagates W3C `traceparent` plus the app-level `x-singularity-trace-id` to Context Fabric. Remaining work is a release smoke gate that proves the full Workgraph → Context Fabric → Agent Execution Runtime/MCP trace appears as one distributed trace in the target environment.
- **Deploy secrets** — Dockerfiles, CI image builds, manual deploy workflow, deploy preflight guardrails, and a required GitHub Environment secret-name manifest/checker exist. Each target must still run `bin/check-github-environment-secrets.py --github-environment <env>` plus `bin/check-deploy-env.sh` before release.

Recently closed:

- **AgentRun correlation columns** — Workgraph `agent_runs` has first-class indexed fields for `traceId`, `cfCallId`, `promptAssemblyId`, `mcpServerId`, `mcpInvocationId`, `contextPackageId`, `modelCallId`, and `laptopInvocationId`. New workflow, approval-resume, and laptop completion paths now keep those columns synchronized while read paths prefer the columns and fall back to `AgentRunOutput.structuredPayload` for older rows.

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
#   ✓ synced → platform-web public assets
#   ✓ synced → agent-and-tools/web/public/
#   ✓ synced → workgraph-studio/apps/web/public/
#   ✓ 3 app(s) updated.
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
│   │   ├── agent-service/      # agents + merged tool registry (tool-service folded in)
│   │   ├── agent-runtime/
│   │   └── prompt-composer/    # composition plane
│   ├── packages/
│   ├── web/                    # Next.js — the canonical platform-web (:5180)
│   └── docker-compose.yml      # per-app compose (alternative to master)
├── context-fabric/             # Python — 4× FastAPI for LLM optimization
├── workgraph-studio/           # TS pnpm workspace — DAG designer + runtime
│   ├── apps/api/               # Express + Prisma
│   ├── apps/web/               # React + ReactFlow — now library source compiled into platform-web
│   ├── apps/blueprint-workbench/ # blue cockpit — now library source compiled into platform-web
│   ├── packages/{shared-types,engine}/
│   └── infra/docker/docker-compose.yml
└── edge-gateway/               # optional legacy/debug multi-app gateway (frontend-legacy profile)
```

---

## License & ownership

Internal Singularity Neo platform. See per-app READMEs for component-level details:

- [docs/README.md](./docs/README.md)
- [context-fabric/README.md](./context-fabric/README.md)
