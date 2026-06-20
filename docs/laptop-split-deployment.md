# Laptop + Box Split Deployment

**Goal:** run the **MCP server** and the **LLM gateway** on your **laptop**, and run **everything else on a different machine** (a server / VM / "box") in Docker. All AI inference (provider keys), the GitHub Copilot CLI, git credentials, and the code sandbox stay on the laptop; the platform (workflow state, IAM, audit, databases, UIs) lives on the box.

> Two related guides: [`hybrid-laptop-deployment.md`](./hybrid-laptop-deployment.md) is the deep env-var reference; [`laptop-bridge-localhost-test.md`](./laptop-bridge-localhost-test.md) is the one-Mac test harness (`bin/laptop-bridge.sh`). **This file is the operator runbook** that ties them together.
>
> **Office variant (cloud box + laptop with Copilot, desktop-app managed):** [`office-cloud-deployment.md`](./office-cloud-deployment.md).

## 0. Quickstart — the two scripts

Everything below is driven by exactly two scripts:

```bash
# ── once: laptop secrets (Copilot BYOK key, GitHub token) ────────────────────
cp .env.laptop.example .env.laptop   # then fill it in — loaded on every run

# ── terminal 1: the Docker BOX (everything except mcp + llm-gateway) ─────────
bin/box.sh up           # core box; add --build after a git pull (or: bin/box.sh rebuild)
bin/box.sh seed         # first time: users, capability, prompts, SDLC workflows

# ── terminal 2 + 3: the LAPTOP apps ──────────────────────────────────────────
bin/laptop.sh gateway   # llm-gateway :8001
bin/laptop.sh mcp       # mcp-server  :7100 (checks `copilot` CLI, frees stale port)

# ── verify, then open http://localhost:5180 ──────────────────────────────────
bin/box.sh status
```

Logins: `admin@singularity.local` / `Admin1234!` (or `user1@singularity.local` …).
`bin/laptop.sh mcp` preflights the two classic failures: a stale process holding
:7100 (EADDRINUSE) is freed automatically, and a missing `copilot` CLI aborts
with the install command (`npm install -g @github/copilot`) instead of failing
later inside a run with `spawn copilot ENOENT`.

---

## 1. Topology

```
        LAPTOP (host apps)                          BOX / SERVER (Docker)
 ┌────────────────────────────┐            ┌─────────────────────────────────────┐
 │  llm-gateway   :8001        │            │  context-api (Context Fabric) :8000   │
 │  mcp-server    :7100        │            │  workgraph-api  :8080                 │
 │  + Copilot CLI              │◀──────────▶│  iam-service / platform-core          │
 │  + git creds (GITHUB_TOKEN) │   bridge   │  (agent/tool/runtime/composer APIs)   │
 │  + BYOK provider key        │     or     │                                       │
 │                             │   direct   │  platform-web :5180                   │
 │                             │   HTTP     │  Postgres (wg :5434, at :5432) / MinIO│
 └────────────────────────────┘            └─────────────────────────────────────┘
```

| Component | Port | Runs on | Runtime |
|---|---|---|---|
| **llm-gateway** | 8001 | **Laptop** | Python (uvicorn) |
| **mcp-server** | 7100 | **Laptop** | Node 20 |
| Copilot CLI / local model | — | **Laptop** | external |
| context-api (Context Fabric) | 8000 | Box | Docker |
| workgraph-api | 8080 | Box | Docker |
| iam / platform-core | 8100 / 3001-3004 | Box | Docker |
| platform-web | 5180 | Box | Docker |
| legacy split UIs / edge-gateway | 5174 / 5175 / 5176 / 5181 / 8085 | Box | Docker, debug profile only |
| Postgres (workgraph / app) + MinIO | 5434 / 5432 / 9000 | Box | Docker |

**Why the laptop:** provider keys, `GITHUB_TOKEN`, the Copilot CLI, and the work-item code sandbox never leave the laptop. The box stores work-items, workflow state, audit, prompts, and approvals.

---

## 2. Connectivity: Bridge vs Direct

Pick one. **Bridge is recommended** — it needs no inbound port on the laptop.

### Bridge mode (recommended, NAT-safe)
The laptop opens an **outbound WebSocket** to the box's Context Fabric; the box sends `tool-run` / `model-run` / `code-context` frames back over the same socket. The box never dials into the laptop.

- Laptop sets `LAPTOP_MODE=true` + `LAPTOP_BRIDGE_URL=wss://<box-host>:8000/api/laptop-bridge/connect` + a device JWT.
- Box and laptop share one **`JWT_SECRET`** (the device token is signed with it).
- A run routes to the laptop when `run_context.prefer_laptop=true` (MCP) / `PREFER_LAPTOP_LLM=true` (LLM).

### Direct-HTTP mode (fallback)
The box calls the laptop's mcp/gateway over HTTP at `http://<laptop-host>:7100` / `:8001`. Requires a **private path** box→laptop (Tailscale, corporate VPN, Cloudflare Tunnel). Expose only 7100 (+ 8001 if the box's own LLM calls go to the laptop). Always TLS + strong bearer tokens.

---

## 3. The BOX (the other machine), in Docker

mcp-server and llm-gateway are behind compose profiles, so a default `up` **excludes** them. Bring up the core box:

**Bridge mode** — no laptop address needed, just the shared secret:
```bash
export JWT_SECRET=<one-shared-secret>
docker compose up -d
# expose context-api :8000 so the laptop can reach /api/laptop-bridge/connect
```

Optional box-side services are explicit:

```bash
docker compose --profile verification up -d formal-verifier
docker compose --profile compression up -d prompt-compressor
```

**Direct-HTTP mode** — re-point the box's MCP/LLM consumers at the laptop with the ready-made overlay:
```bash
export JWT_SECRET=<shared> MCP_BEARER_TOKEN=<shared> LAPTOP_HOST=<laptop-ip-or-tailscale>
docker compose -f docker-compose.yml -f docker-compose.remote.yml up -d
```
`docker-compose.remote.yml` sets `MCP_SERVER_URL=http://<LAPTOP_HOST>:7100` on the MCP consumers, including `platform-core`; uncomment its `LLM_GATEWAY_URL` line where needed for "all AI on the laptop".

---

## 4. The LAPTOP (host apps)

### Recommended pairing: Access Key (PAT) → device token (no hand-rolled tokens)

The real auth path goes through IAM, not a hand-minted secret:

1. **Generate an Access Key** (the GitHub-like PAT) in Platform Web: `http://<box>:5180/operations/access-keys`.
2. **Pair** the laptop with it, either way:
   - **Singularity Desktop** (`clients/singularity-desktop`) — paste the Access Key (or sign in), and it exchanges it at IAM `POST /api/v1/auth/device-token` for a 90-day device token, stores it in the OS keychain, spawns `mcp-server` in `LAPTOP_MODE`, and (one toggle) runs a **Copilot LLM shim** so you don't run a separate `llm-gateway`.
   - **CLI** — `singularity-mcp login --email you@org --platform http://<box>:8100/api/v1`, then `singularity-mcp start --bridge wss://<box>:8000/api/laptop-bridge/connect`.

The device token's `sub` is your IAM user id; CF routes runs with that `user_id` to this laptop. The manual `export SINGULARITY_DEVICE_TOKEN=…` / `bin/laptop-bridge.sh mint-token` below is a **dev shortcut** for the one-Mac test only — prefer the Access Key + desktop app / CLI for real deployments.

### Manual (dev / single-machine)


**LLM gateway** (Python 3.11):
```bash
cd context-fabric && python -m venv .venv && . .venv/bin/activate
pip install -r services/llm_gateway_service/requirements.txt
export PYTHONPATH="$PWD:$PWD/shared" \
  LLM_PROVIDER_CONFIG_PATH=./.singularity/llm-providers.json \
  LLM_MODEL_CATALOG_PATH=./.singularity/llm-models.json \
  ANTHROPIC_API_KEY=...           # or COPILOT_TOKEN, etc. — laptop only
uvicorn services.llm_gateway_service.app.main:app --host 0.0.0.0 --port 8001
```

**mcp-server** (Node 20) — export your Copilot BYOK + git creds first:
```bash
cd mcp-server && npm install && npm run build
export PORT=7100 MCP_BEARER_TOKEN=<shared> LLM_GATEWAY_URL=http://localhost:8001 \
  MCP_COMMAND_EXECUTION_MODE=process MCP_SANDBOX_ROOT=$HOME/sg-workspace \
  COPILOT_PROVIDER_TYPE=anthropic COPILOT_PROVIDER_BASE_URL=https://api.anthropic.com \
  COPILOT_PROVIDER_API_KEY=sk-ant-... COPILOT_MODEL=claude-sonnet-4-6 \
  MCP_GIT_PUSH_ENABLED=true MCP_GIT_AUTH_MODE=token GITHUB_TOKEN=ghp_...

# Bridge mode: dial out to the box
export JWT_SECRET=<shared> LAPTOP_MODE=true \
  LAPTOP_BRIDGE_URL=wss://<box-host>:8000/api/laptop-bridge/connect \
  SINGULARITY_DEVICE_TOKEN=<HS256 device JWT: kind=device, sub=<user_id>, device_id=...>
npm run dev

# Direct-HTTP mode instead: run a normal server and expose :7100 via your tunnel
npm run dev   # (without LAPTOP_MODE)
```

---

## 5. Local single-machine test (one Mac)

To rehearse the whole split on **one machine** (box in Docker + mcp/gateway as host apps reaching it via `host.docker.internal`), use the helper — no two machines needed:

```bash
bin/laptop-bridge.sh rebuild         # rebuild the box images after a pull
bin/laptop-bridge.sh box-up-direct   # box in Docker, pointed at the host mcp/gateway
bin/laptop-bridge.sh gateway         # terminal 2 — host llm-gateway
bin/laptop-bridge.sh mcp-direct      # terminal 3 — host mcp (export BYOK + git creds first)
bin/laptop-bridge.sh status          # llm-gateway / mcp-server / context-api should be UP
```
Details + bridge-mode variant: [`laptop-bridge-localhost-test.md`](./laptop-bridge-localhost-test.md).

---

## 6. Database migrations + seeds (on the box)

The workgraph DB is the **`wg-postgres`** container (`workgraph`/`workgraph_secret`, host port **5434**). Apply schema changes there. Example — the VERIFIER node type:

```bash
docker compose -f docker-compose.yml -f docker-compose.laptop-direct.yml \
  exec wg-postgres psql -U workgraph -d workgraph \
  -c "ALTER TYPE \"NodeType\" ADD VALUE IF NOT EXISTS 'VERIFIER';"
```
> The DB is `db push`-managed, so `prisma migrate deploy` errors with **P3005** — apply migration `.sql` directly via `psql` as above.

**Seed everything (one command).** A default `up` only auto-seeds DBs, the IAM
super-admin, agent-runtime role templates, and workgraph artifact/demo data — it
does **not** create demo users, prompt-composer prompts, or the SDLC workflows.
`bin/seed-docker.sh` runs all the manual seeds in dependency order (IAM users +
capability → agent bindings → composer prompts → workgraph artifact templates →
SDLC workflows incl. Copilot):
```bash
# direct-mode box: matches box-up-direct (mcp-direct/HTTP)
bin/laptop-bridge.sh seed
# or directly, choosing the knobs:
SEED_PREFER_LAPTOP=false SEED_GOVERNANCE_MODE=fail_open bin/seed-docker.sh
```
Logins after seeding: `admin@singularity.local` / `Admin1234!` (super admin) and
`user1@singularity.local … user10@…` / `Admin1234!` (demo users). The Copilot
SDLC seed's agent-template defaults are the real `00000000-…d#` ids that
agent-runtime seeds, so its nodes bind to existing agents.

---

## 7. The seeded SDLC — Verifier + governance

```
START → Requirements → Design → Develop → QA → Security → Release → Verify documents → GIT_PUSH → END
```
- **Every phase** is an `AGENT_TASK`, `executor='copilot'`, connected to its **role agent template**, running the **governed loop** (`governanceMode`).
- **Verify documents** is a `VERIFIER` node (`scope:'ALL'`) — it runs the verifier agent on **every** document the run produced and **pauses the run (BLOCKED)** with per-doc findings in `context._blockedByVerifier` if any fails the standards. Nothing is pushed unverified.

**Governance mode** (`SEED_GOVERNANCE_MODE`, default `fail_closed`):
- `fail_closed` — governance strictly enforced; **audit-governance must be reachable** or every agent phase fails-closed.
- `fail_open` — governance attempted, run proceeds if audit-gov is briefly unavailable. **Use this if you don't run audit-gov.**

The standards the verifier checks come from the run's `acceptanceCriteria` / `definitionOfDone` / `verificationPolicy` vars + a baseline doc standard; the judge model is the **AUDIT_JUDGE** routing (`/llm-routing`, falls back to the gateway default).

**Routing to the laptop:** the seed defaults to **bridge** — each copilot node carries `preferLaptop:true`, so CF routes the phase to the launching user's laptop over the **outbound** bridge. The box holds **no laptop address**; the laptop dials in. (Set `SEED_PREFER_LAPTOP=false` to use a Direct HTTP mcp instead.) The launch's `run_context.user_id` must equal the device token's `sub` so CF picks the right laptop.

**Run it:** create a `feature` work item (routes to this SDLC at priority 300), set `story` + `repoUrl`, run it with the laptop mcp (bridge) connected and `copilot` on PATH. Approve each phase; the run gates at **Verify documents** before the push.

---

## 8. Required env at a glance

| Var | Box | Laptop | Notes |
|---|---|---|---|
| `JWT_SECRET` | ✓ | ✓ | one shared value (bridge device token is signed with it) |
| `MCP_BEARER_TOKEN` | ✓ | ✓ | shared; ≥16 chars (≥32 in prod) |
| `LAPTOP_MODE` / `LAPTOP_BRIDGE_URL` / `SINGULARITY_DEVICE_TOKEN` | — | ✓ | bridge mode |
| `MCP_SERVER_URL` (=`http://<laptop>:7100`) | ✓ | — | **direct mode only** |
| `PREFER_LAPTOP_LLM` | ✓ (context-api) | — | route the box's own LLM calls to the laptop |
| `COPILOT_PROVIDER_*` / `COPILOT_MODEL` | — | ✓ | Copilot BYOK |
| `MCP_GIT_PUSH_ENABLED` / `MCP_GIT_AUTH_MODE` / `GITHUB_TOKEN` | — | ✓ | git push from the laptop |
| provider keys (`ANTHROPIC_API_KEY`, …) | — | ✓ | **only** next to the laptop gateway, never in compose |

---

## 9. Troubleshooting

- **`bind: address already in use` (3003, 8080, …)** — a leftover **bare-metal stack** or a half-started box holds the ports. Clean slate:
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.laptop-direct.yml down --remove-orphans
  bin/bare-metal.sh down
  kill -9 $(lsof -ti :8080) 2>/dev/null; kill -9 $(lsof -ti :3003) 2>/dev/null
  ```
  Then bring the box up again. Don't run a full bare-metal stack **and** the Docker box — they double-bind every port.
- **Web changes not showing** — the UI lives in the `platform-web` image. After a `git pull`, **rebuild** (`bin/laptop-bridge.sh rebuild`) and hard-refresh (Cmd-Shift-R); a running container serves the old bundle.
- **Enter via Platform Web `http://localhost:5180`** — this is the single origin and the normal entry. The old per-app UIs and edge-gateway are debug-only under the `frontend-legacy` profile.
- **Operations shows LLM / MCP "offline" (split)** — make sure the host gateway + mcp are running and that the direct/bridge overlay points backend health checks at the laptop path. Rebuild + recreate `platform-web` after pulling (`docker compose … build platform-web && … up -d --no-deps platform-web`).
- **`invalid input value for enum NodeType: VERIFIER`** — run the §6 enum migration before the seed.
- **Agent phase fails immediately under `fail_closed`** — audit-governance isn't reachable; re-seed with `SEED_GOVERNANCE_MODE=fail_open`.
- **Bridge shows no laptop** — check `GET https://<box>:8000/api/laptop-bridge/status`; the device token must be signed with the box's `JWT_SECRET` and carry `kind=device`, `sub`, `device_id`.

---

## 10. Security checklist

- Provider keys + `GITHUB_TOKEN` only on the laptop, never in a compose `environment:` block.
- One shared strong `JWT_SECRET` + `MCP_BEARER_TOKEN` across the box and the laptop.
- Bridge mode needs no inbound laptop port. Direct mode needs a private tunnel (Tailscale/VPN/Cloudflare) exposing only 7100 (+ 8001). Use TLS (`wss://`, `https://`) on the box endpoints.
