# Office Deployment — Cloud Box + Laptop (MCP + LLM via Copilot)

All platform apps run on a **cloud box** in Docker; **mcp-server and the LLM run
on your office laptop** through the desktop app, with **GitHub Copilot** as the
model (no Anthropic key at the office). The laptop dials **into** the box over
the bridge — the box holds no laptop address.

```
        OFFICE LAPTOP                                CLOUD BOX (Docker)
 ┌───────────────────────────────┐          ┌────────────────────────────────┐
 │ Singularity Desktop app        │          │ context-api · workgraph-api    │
 │  ├─ mcp runner (LAPTOP_MODE)   │──wss────▶│ iam · prompt-composer · agent-*│
 │  ├─ Copilot shim (:4319)       │  dials   │ UIs · edge-gateway :8085       │
 │  └─ keys in OS keychain        │   in     │ postgres · minio               │
 │ copilot CLI (corp GitHub login)│          │ (NO mcp / NO llm-gateway)      │
 └───────────────────────────────┘          └────────────────────────────────┘
```

---

## A — Cloud box (once)

```bash
# A1. VM with Docker + compose; open ports 8085 (UI), 8000 (bridge), 8100 (IAM)
#     to your office network/VPN only; put TLS in front if possible.

# A2. Clone + the one shared secret
git clone https://github.com/ashokraj2011/singularity-platform.git && cd singularity-platform
export JWT_SECRET='<ONE strong 32+ char secret>'   # signs+verifies device keys — set on EVERY compose run

# A3. Bring up the box — base + the CLOUD overlay (NOT laptop-direct;
#     host.docker.internal would mean "this box", not your laptop)
DC="docker compose -f docker-compose.yml -f docker-compose.cloud.yml"
$DC up -d iam-postgres at-postgres wg-postgres wg-minio
$DC up -d at-postgres-bootstrap
$DC up -d --no-deps iam-service context-memory context-api formal-verifier \
  agent-service tool-service agent-runtime prompt-composer workgraph-api \
  workgraph-web blueprint-workbench user-and-capability agent-web portal edge-gateway

# A4. Seed users + capability + prompts + SDLC workflows — bridge routing ON
COMPOSE_FILES="-f docker-compose.yml -f docker-compose.cloud.yml" \
  SEED_PREFER_LAPTOP=true bin/seed-docker.sh
```

- Entry point: **`http://<box-host>:8085`** (portal `/`, `/operations`, `/workflow`, `/workbench`, `/iam`). The portal's nav defaults are same-origin paths, so they work at the box hostname unchanged.
- Logins after seeding: `admin@singularity.local` / `Admin1234!` (+ `user1…10`).
- `docker-compose.cloud.yml` sets `PREFER_LAPTOP_LLM=true` on context-api: the platform's **own** LLM calls (verifier agent, event-horizon chat, summaries) ride the bridge to your laptop's Copilot shim — there is no llm-gateway container in this topology.

## A-alt — Cloud box WITHOUT Docker (bare-metal)

No Docker/compose on the box? `bin/bare-metal.sh` boots the whole platform as
host processes; **`BOX_ONLY=1`** skips the two laptop apps (mcp-server,
llm-gateway) and sets `PREFER_LAPTOP_LLM=true` on context-api so the platform's
own LLM calls ride the bridge to your laptop.

Prereqs on the box: Node 20 + 22, Python 3.11 + 3.12, pnpm, and a **Postgres +
MinIO you run yourself** (the script connects to them; it never manages them).

```bash
git clone https://github.com/ashokraj2011/singularity-platform.git && cd singularity-platform
export JWT_SECRET='<ONE strong 32+ char secret>'     # the script respects it (and passes it to IAM + context-api)
BOX_ONLY=1 bin/bare-metal.sh up
```

- `up` installs deps, migrates the DBs, and **seeds the SDLC workflows itself**
  (the copilot seed defaults to `preferLaptop:true` — bridge routing on).
- Demo users beyond the super-admin: `seed/apply.sh` (runs the IAM SQL seeds).
- **Entry point on bare-metal is the portal at `http://<box-host>:5180`** (Vite
  apps are served at root base — the `:8085` edge-gateway is a Docker-only
  concern; per-app ports `:5174/:5176` work directly here).
- Laptop settings (§B) are identical — point Platform/Bridge at
  `http://<box-host>:8100/api/v1` and `ws://<box-host>:8000/api/laptop-bridge/connect`.
- Stop with `bin/bare-metal.sh down`; status with `bin/bare-metal.sh status`.

## B — Office laptop (once)

```bash
# B1. Prereqs: Node 20+, git, and the GitHub Copilot CLI on your CORPORATE account
npm install -g @github/copilot
copilot                      # complete the GitHub device login once

# B2. Clone + build the runner + the desktop app
git clone https://github.com/ashokraj2011/singularity-platform.git && cd singularity-platform
cd mcp-server && npm install && npm run build
cd ../clients/singularity-desktop && npm install
npm start                    # launch from a terminal so the runner inherits PATH (finds `copilot`)
```

**In the app:**
1. **Settings**
   - Platform (IAM): `http://<box-host>:8100/api/v1`
   - Bridge: `ws://<box-host>:8000/api/laptop-bridge/connect` (`wss://` behind TLS)
   - ✅ **"Run LLM on this laptop via Copilot"** — replaces the llm-gateway. First start the Copilot bridge in a terminal: `npx copilot-api@latest start --port 4141`
   - **Credentials:** GitHub token (`ghp_…`, used by the GIT_PUSH stage). **Leave the Anthropic key EMPTY** — the copilot CLI uses your corporate GitHub login. Clear the Copilot-model field (let Copilot pick the org-approved model).
   - Save (saving credentials auto-restarts the runner).
2. **Pair → "Generate key & connect"** with your platform login — the SAME user you will launch runs as. The app mints the Connection Key via IAM, stores it in the keychain, starts the runner, and registers with Context Fabric.
3. Verify: Dashboard shows `registered with bridge`; from any machine:
   ```bash
   curl -s http://<box-host>:8000/api/laptop-bridge/status     # → "count": 1
   ```

## C — Daily use

1. Open the desktop app → **Start runner** (one button = runner + shim; menu-bar dot ●).
2. `http://<box-host>:8085` → log in **as the paired user** → create a `feature` work item (`story` + `repoUrl` = your office GitHub repo) → run.
3. Phases execute on your laptop via Copilot → answer the **Questions** tab if Copilot asks → **Verify documents** gate → GIT_PUSH with your token.

## D — Office gotchas

- **Corporate proxy:** the laptop needs outbound `ws(s)://<box>:8000`; npm/Copilot may need your proxy/registry config (Artifactory image builds: [`artifactory-npm.md`](./artifactory-npm.md)).
- **The app must be running** for stages to execute — runs fail fast with `MCP_NOT_CONNECTED` when it's off. The tray dot is the health check; the Operations page MCP indicator is bridge-aware.
- **Same user everywhere:** pair and launch runs as the same login — Context Fabric routes runs to your laptop by user id.
- **No Anthropic key at the office:** a 401 at `api.anthropic.com` means an old BYOK key is still configured — clear the Anthropic field in Settings → Credentials (the runner auto-restarts).
- **Box upgrades:** `git pull && $DC build context-api workgraph-api workgraph-web portal && $DC up -d --no-deps <same app list>`.

> Related: [`laptop-split-deployment.md`](./laptop-split-deployment.md) (single-machine + BYOK variants), [`hybrid-laptop-deployment.md`](./hybrid-laptop-deployment.md) (full env reference).
