# Unified Platform Web

`agent-and-tools/web` is the canonical frontend for the platform. The default Docker stack exposes one UI container:

```text
platform-web  http://localhost:5180
```

Backend/API planes remain separate, but the agent-and-tools APIs now share one `platform-core` Docker container. `platform-web` runs nginx on container port `80` and proxies to the bundled Next standalone server on internal port `3000`.

The default Docker stack is now product-core only. Runtime infrastructure that may be deployed elsewhere stays behind explicit profiles:

| Profile | Starts |
|---|---|
| `core` | platform-web, IAM, platform-core, context-api, Workgraph, Postgres, MinIO |
| `llm-gateway` | local LLM gateway |
| `mcp` | local MCP/tool runtime and sandbox runner |
| `gateway-only` | shared Postgres + local LLM gateway only |
| `composer-only` | shared Postgres + bootstrap + local LLM gateway + prompt-composer only |
| `backend-split` | product stack with split agent/tools backend containers instead of platform-core |
| `verification` | formal verifier |
| `compression` | prompt compressor |
| `audit` | audit-governance side stack through `singularity.sh` |
| `full` | historical all-local stack |

## Canonical Routes

| Route | Surface |
|---|---|
| `/` | Platform home |
| `/operations` | Readiness, setup, trust, and service health |
| `/agents` | Agent and tool surfaces |
| `/agents/studio` | Agent Studio |
| `/workflows` | Workgraph manager surfaces |
| `/workbench` | Blueprint Workbench |
| `/foundry` | Code Foundry |
| `/identity` | IAM, users, teams, roles, and capabilities |
| `/engine` | Singularity Engine failure triage and evaluator loop |

Legacy paths redirect into the new tree:

```text
/agent/*          -> /agents/*
/agent-studio     -> /agents/studio
/workflow/<id>    -> /runs/<id>
/design/<id>      -> /workflows/design/<id>
/mission-control/<id> -> /runs/<id>/insights
/iam/*            -> /identity/*
/agent-templates  -> /agents/studio
```
Additional Workgraph legacy routes such as `/dashboard`, `/planner`, `/runtime`, `/connectors`, `/metadata`, `/play/new`, `/artifacts`, and `/llm-routing` redirect to their closest native Platform Web surface.

## Docker

Default startup:

```bash
./singularity.sh up
./singularity.sh urls
```

Optional local runtime infrastructure:

```bash
./singularity.sh up --profile llm-gateway
./singularity.sh up --profile mcp
./singularity.sh up --profile gateway-only
./singularity.sh up --profile composer-only
./singularity.sh up --profile audit
./singularity.sh backend-split
./singularity.sh up --full
./singularity.sh core-only
```

For remote deployments, leave those profiles off and configure the service URLs/tokens instead.
If a previous `--full` run left optional containers running, `./singularity.sh core-only` stops the optional/runtime containers without deleting volumes and brings the product core back up.
The Operations readiness pages also expose `/api/runtime-infrastructure`, which separates required core service health from optional or remotely deployed runtime services such as MCP, LLM Gateway, Formal Verifier, and audit-governance.
Foundry routes are part of the core UI and are backed by Workgraph's `/api/codegen` routes. The standalone `code-foundry-api` container is no longer part of the normal stack; the old standalone `code-foundry-web` dev server remains behind the shared `frontend-legacy` debug profile.

When upgrading an existing local or server deployment, run `bin/migrate-code-foundry-to-workgraph.sh` once after Workgraph migrations have applied. It imports legacy `singularity_codegen` runs, artifacts, gaps, LLM patch tasks, verification rows, and receipts into Workgraph, and hydrates artifact content when old workspace files are still present. Use `CODE_FOUNDRY_IMPORT_TENANT_ID=<tenant-id>` if imported rows must be assigned to a tenant immediately.

Production-class environments (`APP_ENV`, `ENVIRONMENT`, or `SINGULARITY_ENV` set to `prod`, `production`, or `staging`) now fail closed when core services still use known development secrets, weak service tokens, optional-auth mode, or non-strict tenant/auth settings. `NODE_ENV` is used only as a fallback when those platform envs are absent, so Docker's production Next runtime can still run local/dev stacks.
Set `APP_ENV=production` or `SINGULARITY_ENV=production` to activate the guardrails. Production-class deployments must also set `AUTH_OPTIONAL=false`, `TENANT_ISOLATION_MODE=strict`, and `REQUIRE_TENANT_ID=true`.
Because `platform-web` now owns server-side proxies for Workbench audit-governance, Workgraph, and Prompt Composer service auth, production-class web containers require strong `AUDIT_GOV_SERVICE_TOKEN` and `WORKGRAPH_PROXY_SERVICE_TOKEN`. `WORKGRAPH_PROXY_SERVICE_TOKEN` is not a random shared secret: it must be a pre-minted IAM service JWT for the `platform-web` service, because Platform Web sends it as `Authorization: Bearer ...` to Workgraph and Prompt Composer's IAM-authenticated routes. Mint and write it with `./singularity.sh config mint-workgraph-proxy-token` after `production-guardrails` has written tenant scopes. `PROMPT_COMPOSER_SERVICE_TOKEN` may override that token for Composer-only deployments, but the default is to reuse the platform-web IAM JWT. The web container refuses to start, and its proxy routes return `503`, if those values are missing, malformed, or still use development defaults.

For Dockerized services that need to call remote runtime infrastructure from inside containers, use internal URL overrides:

```bash
MCP_SERVER_INTERNAL_URL=https://mcp.example.com
LLM_GATEWAY_INTERNAL_URL=https://llm-gateway.example.com
FORMAL_VERIFIER_INTERNAL_URL=https://verifier.example.com
```

Targeted rebuild:

```bash
docker compose build platform-core platform-web
docker compose up -d --no-deps platform-core platform-web
```

Normal `docker compose config --services` should include `platform-web` and `platform-core`, and should not include the old split frontend services. The old UIs are retained only under the `frontend-legacy` profile for debugging/backward compatibility; the legacy portal is on `:5182` so it no longer competes with Platform Web on `:5180`.
The old split agent/tools backend containers remain available for debugging through `./singularity.sh backend-split` or `COMPOSE_PROFILES=backend-split docker compose up -d`. Do not combine `core` and `backend-split`; both layouts publish ports `3001-3004`. Return to the default consolidated layout with `./singularity.sh core-only`.

To inspect the active shape after install or restart:

```bash
./singularity.sh topology
```

The default Docker topology should report `platform-core` as the active agent/tools plane and show `agent-service`, `tool-service`, `agent-runtime`, and `prompt-composer` as API ports served by that one container. In `backend-split`, those four services run as separate debug containers instead.

The default core stack currently has 8 running containers: `platform-web`, `platform-core`, `iam-service`, `workgraph-api`, `context-api`, `at-postgres`, `wg-postgres`, and `wg-minio`. `llm-gateway`, `mcp-server`, verification, compression, audit-governance, and legacy split UIs are optional profiles or remote services. `./singularity.sh topology` is the authoritative local inventory; it also fails if legacy frontend containers are running next to `platform-web` or if split agent/tools containers are mixed with `platform-core`.

## Bare Metal

Bare metal also starts Platform Web on `:5180`:

```bash
bin/bare-metal.sh up <db_user> [db_password] [db_host] [db_port]
bin/bare-metal.sh smoke
```

The bare-metal script does not start the old split Vite frontend apps by default. Bare-metal still runs the Node backend apps as separate local processes for hot reload; the single-container `platform-core` consolidation is a Docker packaging change. Set `BOX_ONLY=1` when the LLM gateway and MCP runtime should run somewhere else:

```bash
BOX_ONLY=1 bin/bare-metal.sh up <db_user> [db_password] [db_host] [db_port]
```

## Verification

```bash
for path in / /operations /agents /agents/studio /workflows /workbench /foundry /identity; do
  printf '%-16s ' "$path"
  curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:5180$path"
done
```

Expected result: every route returns `200`; legacy paths return redirects to the canonical routes.
If `curl` is not available on a bare-metal host, use `bin/doctor.sh` or `bin/bare-metal.sh smoke`; both use Python HTTP fallbacks.
For the full canonical route and legacy redirect matrix, run:

```bash
python3 bin/check-platform-web-routes.py
```

`./singularity.sh doctor` runs this route smoke by default. It checks the migrated domain routes, common sidebar links, legacy redirects, and a small set of compatibility API endpoints, and it fails if an HTML route renders known broken placeholders or an API route returns non-JSON `Internal Server Error` text.

For the backend/API proxy parity matrix, run:

```bash
python3 bin/check-platform-api-parity.py
```

`./singularity.sh doctor` also runs this API parity smoke by default. It checks the canonical Platform Web proxy families (`/api/iam`, `/api/agents`, `/api/tools`, `/api/runtime`, `/api/composer`, `/api/workgraph`, `/api/cf`, `/api/codegen`) plus legacy aliases such as `/workflow/api/*`, `/workflows/api/*`, `/workbench/api/*`, and `/foundry/api/codegen/*`. Every checked endpoint must return parseable JSON; raw HTML upstream errors and text `Internal Server Error` responses fail the audit.

For July backup route parity, run:

```bash
python3 bin/check-platform-web-parity.py
```

That checker covers representative legacy paths from Portal, Workgraph, IAM, Agent Web, and Code Foundry, including `/engine`, `/templates`, `/workflow`, `/history`, `/iam/*`, and the old Agent Studio links. Set `SINGULARITY_DOCTOR_PARITY_SMOKE=1` to include it in `./singularity.sh doctor`; `SINGULARITY_DOCTOR_DEEP_SMOKE=1` includes it as part of the full migration parity audit.

For browser-level migration parity, run:

```bash
node bin/check-platform-web-ui.mjs
```

That headless Chrome smoke check verifies the migrated workflow template list, React Flow designer, Planner, Inbox, runs dashboard, Eval Curation, Blueprint Workbench, Operations readiness, Agent Studio source-backed skill creation, Prompt Workbench, Foundry, Singularity Engine, Identity, and Variables surfaces hydrate inside Platform Web. Set `SINGULARITY_DOCTOR_UI_SMOKE=1` when running `./singularity.sh doctor` to include this heavier browser check in an installation audit. Set `SINGULARITY_DOCTOR_DEEP_SMOKE=1` to run the browser check plus the route parity, workflow, Workbench, Foundry, and Agent Profile lifecycle checks together.

For mutating workflow lifecycle parity, run:

```bash
python3 bin/check-workflow-lifecycle.py
```

That script uses the same Platform Web `/api/workgraph` proxy the UI uses. It creates a temporary workflow, patches metadata, writes a minimal START -> END design graph, verifies graph readback, starts the workflow from a WorkItem, verifies child run completion and WorkItem submission, verifies run delete/archive compatibility, approves and archives the WorkItem, then archives the workflow. Set `SINGULARITY_DOCTOR_LIFECYCLE_SMOKE=1` to include it in `./singularity.sh doctor`.

For Workbench lifecycle parity without optional GitHub/MCP/LLM services, run:

```bash
python3 bin/check-workbench-lifecycle.py
```

That script uses the same Platform Web `/workbench/api` compatibility proxy the migrated Workbench UI uses. It creates a temporary Workbench session, verifies lightweight status polling, patches runtime settings, writes and reads stage chat, then abandons the temporary session. Set `SINGULARITY_DOCTOR_WORKBENCH_SMOKE=1` to include it in `./singularity.sh doctor`.

For deterministic Code Foundry parity, run:

```bash
python3 bin/check-foundry-lifecycle.py
```

That script uses the same Platform Web `/api/codegen` proxy the migrated Foundry UI uses. It validates a service spec, generates a temporary run, reads generated artifacts and file content, fetches the receipt, and checks the read-only repo/change-plan indexes without calling LLM patching or verification. Set `SINGULARITY_DOCTOR_FOUNDRY_SMOKE=1` to include it in `./singularity.sh doctor`.

For local audit-governance side-stack parity, first start the side stack and then run:

```bash
./singularity.sh up --profile audit
python3 bin/check-audit-governance-lifecycle.py
```

That script verifies `/healthz/strict`, ingests a synthetic audit event through Platform Web `/api/audit-gov`, queries it back through the same proxy, and confirms direct persistence in audit-governance. Set `SINGULARITY_DOCTOR_AUDIT_SMOKE=1` after starting the audit profile to include it in `./singularity.sh doctor`.

For Agent Studio source-backed profile parity, run:

```bash
python3 bin/check-agent-profile-lifecycle.py
```

That script logs in through IAM, calls Platform Web `/api/runtime`, creates a temporary DRAFT profile with local, URL-document, and provider-manifest bindings, verifies the stored source-governance summary at `/agents/profiles/:id/sources`, verifies read-only defaults/provider-lock clamping and failed-closed provider resolution, then archives the profile. Set `SINGULARITY_DOCTOR_AGENT_PROFILE_SMOKE=1` to include it in `./singularity.sh doctor`.

For Docker profile and overlay drift, run:

```bash
bash bin/check-compose-profiles.sh
```

That checker validates the consolidated `platform-core` default, the `backend-split` debug path, subset profiles such as `composer-only` and `gateway-only`, and the laptop/remote compose overlays.

For the live whole-platform Docker topology, run:

```bash
python3 bin/check-platform-topology.py
```

That checker reports the running container count, names the 9 required core containers, shows the four agent/tools API ports served by `platform-core`, and warns about stopped legacy/debug remnants. It fails when a required core container is missing, a legacy frontend is running in the default topology, or split agent/tools services are mixed with `platform-core`.

For the narrower agent/tools backend topology, run:

```bash
bash bin/check-agent-tools-topology.sh
```

That checker confirms the stack is running either one consolidated `platform-core` container or the full split debug backend set, then probes `agent-service`, `tool-service`, `agent-runtime`, and `prompt-composer` health.
