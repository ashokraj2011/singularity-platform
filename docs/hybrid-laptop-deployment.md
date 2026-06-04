# Hybrid Laptop Deployment

**Goal:** run the **LLM Gateway** and the **MCP server** (the agent execution runtime) on your **office laptop**, and run **every other platform service anywhere** (a server, AWS, another box). All AI inference and code execution stay on the laptop; the platform (workflow state, IAM, audit, databases, UIs) lives remotely.

This guide has two halves you can mix:
- **Connectivity** — how the remote platform reaches the laptop runtime (Bridge vs Direct HTTP).
- **Run modes** — **A. with Docker** and **B. without Docker**, for both the laptop and the remote side.

> The original planning notes are in [`office-hybrid-deployment-config.md`](./office-hybrid-deployment-config.md); this is the complete, runnable version.

---

## 1. What runs where

| Service | Port | Runtime | Side |
|---|---|---|---|
| **llm-gateway** | `8001` | Python (uvicorn) | **Laptop** |
| **mcp-server** (agent execution runtime) | `7100` | Node 20 | **Laptop** |
| **mcp-sandbox-runner** (test/command exec) | `7110` | Node 20 | **Laptop** |
| your local model (Copilot headless / Ollama / vLLM) | e.g. `4222` | external | **Laptop** |
| context-api (Context Fabric) | `8000` | Python | Remote |
| workgraph-api | `8080` | Node 22 | Remote |
| iam-service | `8100` | Python | Remote |
| prompt-composer | `3004` | Node 20 | Remote |
| agent-runtime / agent-service / tool-service | `3003 / 3001 / 3002` | Node 20 | Remote |
| formal-verifier / prompt-compressor | `8010 / 8011` | Python | Remote |
| UIs: portal / workgraph-web / blueprint-workbench / user-and-capability / agent-web | `5180 / 5174 / 5176 / 5175 / 3000` | static/Next | Remote |
| edge-gateway (single-origin entry) | `8085` | nginx | Remote |
| Postgres `at-postgres` / `wg-postgres`, MinIO | `5432 / 5434 / 9000` | — | Remote |

**Why the laptop:** provider keys (`.env.llm-secrets`), git credentials (`GITHUB_TOKEN`), local models, and the code sandbox all stay on the laptop. The cloud never sees them.

---

## 2. Connectivity: Bridge vs Direct HTTP

Two LLM/MCP links cross the laptop↔remote boundary:

1. **MCP (agent execution).** The remote orchestrator (Context Fabric) must dispatch agent stages to the laptop's `mcp-server`.
2. **LLM gateway.** `mcp-server` always calls the **laptop** gateway at `http://localhost:8001`. Remote services that *also* make LLM calls (Context Fabric summaries, prompt-composer, agent-runtime) need a gateway too — see §2.3.

### 2.1 Bridge mode — *preferred* (no inbound laptop port)

The laptop opens an **outbound** WebSocket to Context Fabric; the platform sends `invoke`/`tool-run` frames back over the same socket. **AWS never needs to reach into your laptop.**

```
laptop mcp-server ──(outbound WSS, device JWT)──▶ context-api  wss://<remote>/api/laptop-bridge/connect
        ▲                                              │
        └──────────── invoke / tool-run frames ◀───────┘
```

- Endpoint: `WS /api/laptop-bridge/connect` and `GET /api/laptop-bridge/status` on **context-api** (`context-fabric/services/context_api_service/app/laptop_bridge.py`).
- Auth: a **90‑day device JWT** (HS256, signed with the platform's shared `JWT_SECRET`). You mint it once via the mcp-server CLI `login`.
- Routing: a run/stage with `prefer_laptop=true` dispatches to the connected laptop; if `prefer_laptop=true` and no laptop is connected, the run fails fast with `MCP_NOT_CONNECTED`.

Use this unless you have a reason not to. It needs **no open ports** on the laptop and no tunnel.

### 2.2 Direct HTTP mode — fallback

Remote services call the laptop's `mcp-server` (and gateway) over HTTP. Requires a private path from remote→laptop: **Tailscale, corporate VPN, or Cloudflare Tunnel**. Expose only `7100` (and `8001` if remote services use the laptop gateway). Always TLS + strong bearer tokens. Never expose your local-model port (`4222`) publicly.

### 2.3 Where remote LLM calls go (important for "all AI on the laptop")

`mcp-server` (the heavy LLM user) is on the laptop and calls `localhost:8001` — done. But the **remote** platform also makes some LLM calls (Context Fabric summarizer, compression, composer model calls). Pick one:

- **(a) Full-local:** point the remote services' gateway URL at the laptop gateway through the same tunnel (`LLM_GATEWAY_URL=http://<laptop>:8001`). Every token stays on the laptop. Adds round-trip latency for those secondary calls.
- **(b) Split:** run a *second* gateway remotely for platform-internal calls (summaries/compression) and keep the laptop gateway for the agent loop. Two `.env.llm-secrets`.
- **(c) Off:** disable the optional remote LLM features (`COMPRESSION_ENABLED=false`, no `SUMMARIZER_MODEL_ALIAS`) so only the agent loop (laptop) uses a model.

For a true "AI only on my laptop" posture, use **(a)** or **(c)**.

---

## 3. The cross-service env vars you re-point

When services are split across hosts, these are the only vars that must change from their compose defaults. **Defaults assume one host**; override them on the remote side.

| Env var | Default (single host) | Set to (split) | On which services |
|---|---|---|---|
| `MCP_SERVER_URL` | `http://mcp-server:7100` | **Bridge:** leave as a dummy/default. **Direct:** `http://<laptop>:7100` | context-api, workgraph-api, agent-service, tool-service, agent-runtime, prompt-composer, agent-web |
| `MCP_DEFAULT_BASE_URL` | `http://mcp-server:7100` | same as above | context-api |
| `MCP_BEARER_TOKEN` / `MCP_DEFAULT_BEARER_TOKEN` | `demo-bearer-token-…` | one strong shared token (≥16 chars, ≥32 in prod) | all of the above + laptop mcp-server |
| `LLM_GATEWAY_URL` | `http://llm-gateway:8001` | laptop mcp-server: `http://localhost:8001`. Remote (option a): `http://<laptop>:8001` | mcp-server (+ remote LLM consumers if option a) |
| `LAPTOP_BRIDGE_URL` | — | `wss://<remote-context-api>/api/laptop-bridge/connect` | laptop mcp-server (bridge mode) |
| `JWT_SECRET` | `changeme_dev_only_…` | one shared secret across **all** services incl. the laptop (the bridge device token is signed with it) | everything |
| `*_DATABASE_URL` | `…@at-postgres / @wg-postgres` | `…@<remote-db-host>` | iam, context-api, agent-*, prompt-composer, workgraph-api |

Everything else (`IAM_BASE_URL`, `CONTEXT_FABRIC_URL`, `AGENT_RUNTIME_URL`, `PROMPT_COMPOSER_URL`, `AUDIT_GOV_URL`, internal `*_URL`) stays **remote→remote** and keeps its compose default if the remote stack runs together.

> Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `COPILOT_TOKEN`, …) live **only** in `.env.llm-secrets` next to whichever gateway uses them. Never put them in a compose `environment:` block.

---

## 4. Mode A — with Docker

### 4.1 Laptop side (Docker)

The main `docker-compose.yml` keeps the laptop services behind profiles so you can run *just* them.

**`mcp-server/.env`** (git config + tokens stay here):
```bash
PORT=7100
MCP_BEARER_TOKEN=<strong-shared-runtime-token>      # ≥16 chars; same value the remote uses
LLM_GATEWAY_URL=http://host.docker.internal:8001    # laptop gateway (or http://llm-gateway:8001 if same compose)
LLM_GATEWAY_TIMEOUT_SEC=300

MCP_COMMAND_EXECUTION_MODE=container
MCP_RUNNER_URL=http://mcp-sandbox-runner:7110
MCP_RUNNER_TOKEN=<strong-runner-token>

MCP_GIT_PUSH_ENABLED=true
MCP_GIT_AUTH_MODE=token
MCP_GIT_TOKEN_ENV=GITHUB_TOKEN
GITHUB_TOKEN=<office-approved-github-token>

# Bridge mode → remote:
CONTEXT_FABRIC_URL=https://<remote-context-api>
AGENT_RUNTIME_URL=https://<remote-agent-runtime>
SINGULARITY_IAM_URL=https://<remote-iam>/api/v1
JWT_SECRET=<shared-platform-jwt-secret>
```

**`.env.llm-secrets`** (laptop only — provider/model keys):
```bash
ANTHROPIC_API_KEY=...        # or
COPILOT_TOKEN=...            # if pointing the gateway at local Copilot
# OPENAI_API_KEY / OPENROUTER_API_KEY as needed
```

**Start the laptop pieces:**
```bash
# 1) Gateway + sandbox runner
COMPOSE_PROFILES=gateway-only docker compose up -d llm-gateway
docker compose up -d mcp-sandbox-runner

# 2) Point the gateway at your local model (example: Copilot headless on :4222)
bin/llm-use-copilot.sh --base-url http://host.docker.internal:4222/v1 --model gpt-4o --token copilot-local

# 3a) BRIDGE MODE: log in once, then connect outbound (run mcp-server on the host, not in docker, so the CLI can save the device token)
cd mcp-server && npm install && npm run build
npm run dev:cli -- login --platform https://<remote-iam>/api/v1 --email you@company.com
npm run dev:cli -- start --bridge wss://<remote-context-api>/api/laptop-bridge/connect

# 3b) DIRECT-HTTP MODE instead: just run the server container/host-process and expose :7100 via your tunnel
docker compose up -d mcp-server     # (profile 'full') — or run on the host per §5
```

### 4.2 Remote side (Docker)

Run the rest of the stack with your normal compose, plus a small **override** for the split. Create `docker-compose.remote.yml`:

```yaml
# docker-compose.remote.yml — apply with: docker compose -f docker-compose.yml -f docker-compose.remote.yml up -d
services:
  # --- shared identity: the bridge device token is signed with this ---
  iam-service:        { environment: { JWT_SECRET: ${JWT_SECRET} } }
  context-api:        { environment: { JWT_SECRET: ${JWT_SECRET} } }
  workgraph-api:      { environment: { JWT_SECRET: ${JWT_SECRET} } }

  # --- DIRECT-HTTP MODE ONLY: re-point MCP at the laptop. (Omit in Bridge mode.) ---
  context-api:
    environment:
      MCP_SERVER_URL: http://<laptop>:7100
      MCP_DEFAULT_BASE_URL: http://<laptop>:7100
      MCP_BEARER_TOKEN: ${MCP_BEARER_TOKEN}
      MCP_DEFAULT_BEARER_TOKEN: ${MCP_BEARER_TOKEN}
      # option (a) full-local LLM:
      # LLM_GATEWAY_URL: http://<laptop>:8001
  workgraph-api:   { environment: { MCP_SERVER_URL: http://<laptop>:7100, MCP_BEARER_TOKEN: ${MCP_BEARER_TOKEN} } }
  agent-service:   { environment: { MCP_SERVER_URL: http://<laptop>:7100, MCP_BEARER_TOKEN: ${MCP_BEARER_TOKEN} } }
  tool-service:    { environment: { MCP_SERVER_URL: http://<laptop>:7100, MCP_BEARER_TOKEN: ${MCP_BEARER_TOKEN} } }
  agent-runtime:   { environment: { MCP_SERVER_URL: http://<laptop>:7100, MCP_BEARER_TOKEN: ${MCP_BEARER_TOKEN} } }
  prompt-composer: { environment: { MCP_SERVER_URL: http://<laptop>:7100, MCP_BEARER_TOKEN: ${MCP_BEARER_TOKEN} } }
```

```bash
# On the remote host — do NOT start the laptop services there:
docker compose -f docker-compose.yml -f docker-compose.remote.yml up -d \
  at-postgres wg-postgres wg-minio iam-service context-api workgraph-api workgraph-web \
  blueprint-workbench user-and-capability prompt-composer agent-runtime agent-service \
  tool-service agent-web formal-verifier prompt-compressor portal edge-gateway
```

> In **Bridge mode**, the remote `MCP_SERVER_URL` can stay at its default — it's only a fallback. The real routing happens over the WebSocket when `prefer_laptop=true`.

> If remote DBs are managed (RDS), drop `at-postgres`/`wg-postgres` from the up list and set the `*_DATABASE_URL` vars in the override to the managed endpoints.

---

## 5. Mode B — without Docker

Same topology, processes started directly. Versions: **Node 20** (mcp-server, agent-*, prompt-composer), **Node 22** (workgraph-api), **Python 3.11** (context-api, gateway, verifier, compressor), **Python 3.12** (iam).

### 5.1 Laptop side (no Docker)

**LLM Gateway** (Python 3.11):
```bash
cd context-fabric
python -m venv .venv && . .venv/bin/activate
pip install -r services/llm_gateway_service/requirements.txt
export PYTHONPATH="$PWD:$PWD/shared"
export LLM_PROVIDER_CONFIG_PATH=./.singularity/llm-providers.json
export LLM_MODEL_CATALOG_PATH=./.singularity/mcp-models.json
export ANTHROPIC_API_KEY=...          # or COPILOT_TOKEN, etc. (laptop only)
export LLM_GATEWAY_BEARER=<optional-strong-bearer>
uvicorn services.llm_gateway_service.app.main:app --host 0.0.0.0 --port 8001
# health: curl localhost:8001/health   models: curl localhost:8001/llm/models
```

**Sandbox runner** (Node 20 — needs Docker socket to spawn test containers; if you truly have no Docker, set `MCP_COMMAND_EXECUTION_MODE=process` on mcp-server and skip the runner):
```bash
cd mcp-server && npm install && npm run build
PORT=7110 MCP_RUNNER_TOKEN=<strong-runner-token> \
MCP_RUNNER_HOST_WORKSPACE_PATH=$HOME/sg-workspace \
node dist/runner/server.js
```

**mcp-server** (Node 20):
```bash
cd mcp-server   # already built above
export PORT=7100
export MCP_BEARER_TOKEN=<strong-shared-runtime-token>
export LLM_GATEWAY_URL=http://localhost:8001
export MCP_SANDBOX_ROOT=$HOME/sg-workspace
export MCP_COMMAND_EXECUTION_MODE=container     # or 'process' if no Docker
export MCP_RUNNER_URL=http://localhost:7110
export MCP_RUNNER_TOKEN=<strong-runner-token>
export MCP_GIT_PUSH_ENABLED=true MCP_GIT_AUTH_MODE=token MCP_GIT_TOKEN_ENV=GITHUB_TOKEN GITHUB_TOKEN=<token>
export CONTEXT_FABRIC_URL=https://<remote-context-api>
export AGENT_RUNTIME_URL=https://<remote-agent-runtime>
export JWT_SECRET=<shared-platform-jwt-secret>

# BRIDGE MODE:
npm run dev:cli -- login --platform https://<remote-iam>/api/v1 --email you@company.com
npm run dev:cli -- start --bridge wss://<remote-context-api>/api/laptop-bridge/connect

# DIRECT-HTTP MODE instead: just run the server and expose :7100 via your tunnel
npm start
```

### 5.2 Remote side (no Docker)

Bring up Postgres (`at-postgres` databases: `singularity`, `singularity_composer`, `singularity_iam`, `singularity_context_fabric`) and `wg-postgres` (`workgraph`) however you host them, then start each service. Set `JWT_SECRET` (shared) on every one; in **Direct mode** also set `MCP_SERVER_URL=http://<laptop>:7100` + `MCP_BEARER_TOKEN` on the MCP consumers.

```bash
# iam-service (Python 3.12)
cd singularity-iam-service && python -m venv .venv && . .venv/bin/activate
pip install fastapi "uvicorn[standard]" sqlalchemy asyncpg alembic pydantic pydantic-settings PyJWT "passlib[bcrypt]" "bcrypt<4" httpx python-multipart
DATABASE_URL=postgresql+asyncpg://singularity:singularity@<db>:5432/singularity_iam \
JWT_SECRET=<shared> uvicorn app.main:app --host 0.0.0.0 --port 8100

# context-api (Python 3.11)
cd context-fabric && . .venv/bin/activate   # reuse a venv; pip install -r services/context_api_service/requirements.txt
PYTHONPATH="$PWD:$PWD/shared" \
CONTEXT_FABRIC_DATABASE_URL=postgresql://postgres:singularity@<db>:5432/singularity_context_fabric \
IAM_BASE_URL=http://<remote>:8100/api/v1 PROMPT_COMPOSER_URL=http://<remote>:3004 \
AGENT_RUNTIME_URL=http://<remote>:3003 JWT_SECRET=<shared> \
MCP_DEFAULT_BASE_URL=http://<laptop>:7100 MCP_BEARER_TOKEN=<token> \
uvicorn services.context_api_service.app.main:app --host 0.0.0.0 --port 8000

# workgraph-api (Node 22, pnpm)
cd workgraph-studio && pnpm install
cd apps/api && npx prisma generate --generator client && npx prisma migrate deploy
DATABASE_URL=postgresql://workgraph:workgraph_secret@<db>:5434/workgraph \
JWT_SECRET=<shared> IAM_BASE_URL=http://<remote>:8100/api/v1 \
CONTEXT_FABRIC_URL=http://<remote>:8000 PROMPT_COMPOSER_URL=http://<remote>:3004 \
MCP_SERVER_URL=http://<laptop>:7100 MCP_BEARER_TOKEN=<token> \
node dist/apps/api/src/index.js      # or: pnpm dev

# agent-runtime / agent-service / tool-service / prompt-composer (Node 20)
#   cd agent-and-tools/apps/<svc> && npm install && npm run build
#   set DATABASE_URL (singularity / singularity_composer), JWT_SECRET=<shared>,
#       IAM_SERVICE_URL=http://<remote>:8100, MCP_SERVER_URL=http://<laptop>:7100, MCP_BEARER_TOKEN=<token>
#   prompt-composer + agent-runtime: run prisma generate first (build script does it), then `npm start` (via ./bin/startup.sh)

# formal-verifier / prompt-compressor (Python 3.11) — optional
#   uvicorn services.formal_verifier_service.app.main:app --port 8010
#   uvicorn services.prompt_compressor_service.app.main:app --port 8011

# UIs (Vite static): build with `npm run build` and serve apps/*/dist with any static server / nginx.
# edge-gateway: optional — only needed for the single-origin :8085 entry. Run nginx with edge-gateway/nginx.conf.
```

---

## 6. Verify

**On the laptop:**
```bash
curl http://localhost:8001/health                                   # gateway up
curl http://localhost:8001/llm/models                               # model catalog
curl -H "authorization: Bearer <token>" http://localhost:7100/healthz/strict   # mcp-server up
```

**Bridge mode — confirm the remote sees the laptop:**
```bash
curl https://<remote-context-api>/api/laptop-bridge/status          # shows the connected device
```

**Direct mode — from a remote box:**
```bash
curl -H "authorization: Bearer <token>" http://<laptop>:7100/healthz/strict
curl http://<laptop>:8001/llm/models
```

**End-to-end:** launch a Workbench run (with `prefer_laptop=true` in bridge mode) and confirm: Context Fabric dispatches the stage to the laptop runtime → mcp-server calls the **laptop** gateway → code checkout/tests/git happen on the laptop → the remote stores work-items, workflow state, audit, prompts, and approvals.

---

## 7. Security checklist

- **Provider keys** (`ANTHROPIC_API_KEY`, `COPILOT_TOKEN`, …) only in `.env.llm-secrets` on the laptop; never in a compose `environment:` block.
- **Git creds** (`GITHUB_TOKEN`) only on the laptop (`mcp-server/.env`).
- **Tokens ≥16 chars** (≥32 in prod) for `MCP_BEARER_TOKEN` / `MCP_RUNNER_TOKEN`; the platform refuses known-bad demo values in `NODE_ENV=production`.
- **One shared `JWT_SECRET`** across the whole platform *and* the laptop — the bridge device token is signed with it.
- **Bridge mode needs no inbound laptop port.** Direct mode needs a private tunnel (Tailscale/VPN/Cloudflare) exposing only `7100` (+ `8001` for option-a LLM); never expose the local-model port.
- Use **TLS** on the remote endpoints (`wss://`, `https://`).
