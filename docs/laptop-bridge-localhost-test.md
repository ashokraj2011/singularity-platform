# Laptop bridge — localhost split test

Run the platform **box** in Docker and the **mcp-server + llm-gateway** as two
host apps on the *same* machine, talking over the **laptop bridge** (the host
mcp-server dials *out* to the Dockerized Context Fabric over a WebSocket). This
exercises the laptop-routing paths end to end:

| Path | Bridge frame | Where it runs |
|---|---|---|
| Tool dispatch (incl. `copilot_execute`) | `tool-run` | host mcp-server |
| CF's own LLM (governed turn, single-turn, summarizer) | `model-run` | host llm-gateway |
| Repo world model / code-context | `code-context` | host mcp-server |

Everything else (workflow state, IAM, audit, Postgres, UIs) stays in the Docker box.

Driver: [`bin/laptop-bridge.sh`](../bin/laptop-bridge.sh) · overlay: [`docker-compose.laptop-bridge.yml`](../docker-compose.laptop-bridge.yml).

---

## Why this is "two apps", not Docker

`mcp-server` (`profiles: [mcp, full]`) and `llm-gateway` (`profiles: [llm-gateway, full, gateway-only, …]`)
are already **profile-gated** in `docker-compose.yml`, so a normal box bring-up
leaves them out. The driver starts the box with `--no-deps` + an explicit
core service list so `context-api`'s optional `depends_on` can't pull them back in — then you
run those two as plain host processes (`npm run dev`, `uvicorn`). That's the same
topology as the office deployment, just collapsed onto one machine via
`host.docker.internal`.

> For the **two-machine** office version (and Direct-HTTP fallback) see
> [`hybrid-laptop-deployment.md`](./hybrid-laptop-deployment.md). This doc is the
> single-machine **bridge** test.

---

## Prerequisites

- Docker Desktop (provides `host.docker.internal`).
- Node 20 + the mcp-server deps: `cd mcp-server && npm install`.
- A Python env for the gateway. Easiest: reuse the bare-metal venv
  (`context-fabric/.venv`) — the driver activates it automatically if present.
  Otherwise `pip install -r context-fabric/services/llm_gateway_service/requirements.txt`.
- Your **provider key** for the gateway in `.env.llm-secrets` (e.g.
  `ANTHROPIC_API_KEY=…`) or exported in the shell that runs `gateway`.
- (Optional, for the Copilot SDLC + git push) export `COPILOT_PROVIDER_TYPE`,
  `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_MODEL`,
  `MCP_GIT_PUSH_ENABLED=true`, `MCP_GIT_AUTH_MODE=token`, `GITHUB_TOKEN` in the
  shell that runs `mcp` — they pass straight through.

> **One shared secret.** The box verifies the laptop's device JWT with
> `JWT_SECRET`; the driver signs the JWT with the *same* value. The default dev
> secret works as-is. To use your own: `export JWT_SECRET=…` in **every**
> terminal below.

---

## Run it (4 steps, 3 terminals)

```bash
# ── Terminal 1 — mint the device token, then bring up the box ────────────────
# <iam-user-id> = the 'sub' of the user who will launch runs (see "Find your
# user id" below). The bridge routes to this laptop by that user id.
bin/laptop-bridge.sh mint-token <iam-user-id>
bin/laptop-bridge.sh box-up        # core Docker box, WITHOUT mcp-server / llm-gateway
# Optional: add --with-verifier, --with-compression, or --with-legacy-ui.
# Foundry API is core; --with-foundry is accepted only for old scripts.

# ── Terminal 2 — host llm-gateway on :8001 ───────────────────────────────────
bin/laptop-bridge.sh gateway

# ── Terminal 3 — host mcp-server in bridge mode (dials out to the box) ────────
bin/laptop-bridge.sh mcp
```

`mcp` logs `[laptop-mode] relay client started` then `registered with bridge` on
success. `gateway` and `mcp` stay in the foreground — Ctrl-C to stop.

---

## Alternative: Direct mode (simplest — best for testing a Copilot SDLC run)

Bridge mode tests the *routing* (it requires a node with `preferLaptop:true`).
If you just want to run a Copilot SDLC stage on the bare-metal mcp — e.g. to test
the **clarifying-questions** feature — use **Direct mode**: the box calls the host
mcp/gateway over plain HTTP at `host.docker.internal`. No device token, no
`prefer_laptop`, no bridge.

```bash
# T1 — rebuild the feature-code images (after a git pull), then the box
bin/laptop-bridge.sh rebuild          # context-api, workgraph-api, platform-web
bin/laptop-bridge.sh box-up-direct    # box → host mcp via host.docker.internal:7100

# T2 — host llm-gateway
bin/laptop-bridge.sh gateway

# T3 — host mcp-server as a normal HTTP server (NOT laptop mode).
#      Export Copilot BYOK + git creds first so the SDLC + push work:
export COPILOT_PROVIDER_TYPE=anthropic COPILOT_PROVIDER_BASE_URL=https://api.anthropic.com \
       COPILOT_PROVIDER_API_KEY=sk-ant-... COPILOT_MODEL=claude-sonnet-4-6 \
       MCP_GIT_PUSH_ENABLED=true MCP_GIT_AUTH_MODE=token GITHUB_TOKEN=ghp_...
bin/laptop-bridge.sh mcp-direct
```

`bin/laptop-bridge.sh status` should show **mcp-server (:7100) UP**. Then launch a
Copilot SDLC run with a deliberately **vague requirements task** (e.g. *"Add a
caching layer"* — no datastore/TTL), so Copilot emits a `## Questions` block.
Open the run → the node's right panel shows an amber **Questions (N)** tab →
answer the cards → **Save answers & re-run** (you'll see the next `copilot -p`
include an `## Answers to your clarifying questions` block).

> **Rebuild matters:** the Copilot-questions feature lives in the *Docker* images
> (`context-api`, `workgraph-api`, `platform-web`), not in mcp. After a `git
> pull`, run `rebuild` or the box will serve stale code.

---

## Verify

```bash
bin/laptop-bridge.sh status
```

Expect `llm-gateway UP`, `context-api UP`, and the bridge status JSON listing
**one connected device** (your `sub` / `laptop-test-<sub>`). You can also hit it
directly:

```bash
curl http://localhost:8001/health                       # gateway
curl http://localhost:8000/api/laptop-bridge/status      # connected laptop(s)
```

**End-to-end:** open Platform Web (http://localhost:5180) → launch a Workbench /
Copilot SDLC run with **`prefer_laptop = true`** (chat already routes via
`PREFER_LAPTOP_LLM=true` set on context-api by the overlay). Watch **Terminal 3** —
you should see `running tool-run`, `running model-run (local LLM)`, and
`running code-context build (local world model)` as the governed loop dispatches
each to the host. Code checkout, tests, and `git push` all happen on the host;
the box stores work-items, audit, prompts, and approvals.

---

## How routing is decided

- **Tools + world model** route to the laptop when the run sets
  `run_context.prefer_laptop = true` (+ a `user_id` matching the JWT `sub`).
  `placement.mcp_laptop_target()` gates it; `dispatch.py` /
  `code_context.py` send the `tool-run` / `code-context` frames.
- **CF's own LLM** routes to the laptop when `PREFER_LAPTOP_LLM=true` (set in the
  overlay) — `placement.llm_laptop_target()` + the `model-run` frame.
- **Any path falls back to cloud/HTTP** if no laptop is connected, so a run never
  hard-fails just because the host apps are down.

---

## Find your user id (`sub`)

The device JWT's `sub` must equal `run_context.user_id` for the run. Get it from:

- Platform Web: after logging in, decode the bearer token (jwt.io) and read `sub`; or
- `curl -H "authorization: Bearer <token>" http://localhost:8100/api/v1/me`.

Re-mint any time: `bin/laptop-bridge.sh mint-token <sub>` (then restart `mcp`).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `mcp` exits: `SINGULARITY_DEVICE_TOKEN unset` | run `mint-token` first (writes `.singularity/laptop-device-token`). |
| bridge status shows no device | `JWT_SECRET` differs between box and mint — export the same value in all terminals, re-mint, restart `mcp`. |
| run didn't use the laptop | run lacked `prefer_laptop=true` / `user_id`, or `user_id` ≠ JWT `sub`. Confirmed in `status`'s device list. |
| `gateway` import errors | activate/install the Python env (see Prerequisites). |
| `box-up` still starts mcp-server / llm-gateway | you ran a bare `docker compose up` (no `--no-deps`); use the driver. |
