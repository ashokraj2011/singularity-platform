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
 │  ├─ Copilot shim (:4319)       │  dials   │ platform-web :5180             │
 │  └─ keys in OS keychain        │   in     │ postgres · minio               │
 │ copilot CLI (corp GitHub login)│          │ (NO mcp / NO llm-gateway)      │
 └───────────────────────────────┘          └────────────────────────────────┘
```

---

## A — Cloud box (once)

```bash
# A1. VM with Docker + compose; open ports 5180 (UI), 8000 (bridge), 8100 (IAM)
#     to your office network/VPN only; put TLS in front if possible.

# A2. Clone + the one shared secret
git clone https://github.com/ashokraj2011/singularity-platform.git && cd singularity-platform
export JWT_SECRET='<ONE strong 32+ char secret>'   # signs+verifies device keys — set on EVERY compose run

# A3. Bring up the box — base + the CLOUD overlay (NOT laptop-direct;
#     host.docker.internal would mean "this box", not your laptop)
DC="docker compose -f docker-compose.yml -f docker-compose.cloud.yml"
$DC up -d

# Optional box-side services:
$DC --profile verification up -d formal-verifier
$DC --profile compression up -d prompt-compressor

# A4. Seed users + capability + prompts + SDLC workflows — bridge routing ON
COMPOSE_FILES="-f docker-compose.yml -f docker-compose.cloud.yml" \
  SEED_PREFER_LAPTOP=true bin/seed-docker.sh
```

- Entry point: **`http://<box-host>:5180`** (`/operations`, `/agents`, `/workflows`, `/workbench`, `/foundry`, `/identity`). Platform Web uses same-origin routes, so links work at the box hostname unchanged.
- Logins after seeding use the bootstrap IAM account shown by `./singularity.sh config show` on the box. Demo users remain available if the seed bundle has not been customized.
- `docker-compose.cloud.yml` sets `PREFER_LAPTOP_LLM=true` on context-api: the platform's **own** LLM calls (verifier agent, event-horizon chat, summaries) ride the bridge to your laptop's Copilot shim — there is no llm-gateway container in this topology.

## A-alt — Cloud box WITHOUT Docker (bare-metal)

No Docker/compose on the box? `bin/bare-metal-apps.sh` boots the platform as
host processes without starting MCP or LLM Gateway. For this cloud-box/laptop
topology, set `PREFER_LAPTOP_LLM=true` so context-api sends the platform's own
LLM calls over the bridge to your laptop. If you intentionally want MCP and LLM
Gateway on the same machine, start them separately with
`bin/bare-metal-runtime.sh up`.

Prereqs on the box: Node 20 + 22, Python 3.11+ (3.12 is fine), pnpm, and a
**Postgres + MinIO you run yourself** (the script connects to them; it never
manages them). If the OS `python3` is older, set `SINGULARITY_PYTHON` to a
Python 3.11+ binary; the launchers rebuild a stale `.venv` that was created
with Python 3.9.

```bash
git clone https://github.com/ashokraj2011/singularity-platform.git && cd singularity-platform
export SINGULARITY_PYTHON="$(brew --prefix python@3.11 2>/dev/null)/bin/python3.11"  # macOS/Homebrew example
export JWT_SECRET='<ONE strong 32+ char secret>'     # the script respects it (and passes it to IAM + context-api)
PREFER_LAPTOP_LLM=true bin/bare-metal-apps.sh up <db_user> [db_password] [db_host] [db_port]
```

- `up` installs deps, migrates the DBs, and seeds IAM demo users/capabilities,
  agent baselines, prompt-composer profiles, Workgraph demo data, and the SDLC
  workflows itself (the copilot seed defaults to `preferLaptop:true` — bridge
  routing on).
- For SQL-only repair/replay, run `seed/apply.sh <db_user> [db_password] [db_host] [db_port]`.
- **Entry point on bare-metal is Platform Web at `http://<box-host>:5180`**.
  Legacy per-app UI ports are debug-only and are not part of the normal office path.
- Laptop settings (§B) are identical — point Platform/Bridge at
  `http://<box-host>:8100/api/v1` and `ws://<box-host>:8000/api/laptop-bridge/connect`.
- Stop with `bin/bare-metal-apps.sh down`; status with `bin/bare-metal-apps.sh status`.

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
   export CONTEXT_FABRIC_SERVICE_TOKEN=<platform-context-fabric-service-token>
   curl -s -H "X-Service-Token: $CONTEXT_FABRIC_SERVICE_TOKEN" http://<box-host>:8000/api/laptop-bridge/status
   ```

## C — Daily use

1. Open the desktop app → **Start runner** (one button = runner + shim; menu-bar dot ●).
2. `http://<box-host>:5180` → log in **as the paired user** → create a `feature` work item (`story` + `repoUrl` = your office GitHub repo) → run.
3. Phases execute on your laptop via Copilot → answer the **Questions** tab if Copilot asks → **Verify documents** gate → GIT_PUSH with your token.

## D — Office gotchas

- **Corporate proxy:** the laptop needs outbound `ws(s)://<box>:8000`; npm/Copilot may need your proxy/registry config (Artifactory image builds: [`artifactory-npm.md`](./artifactory-npm.md)).
- **The app must be running** for stages to execute — runs fail fast with `MCP_NOT_CONNECTED` when it's off. The tray dot is the health check; the Operations page MCP indicator is bridge-aware.
- **Same user everywhere:** pair and launch runs as the same login — Context Fabric routes runs to your laptop by user id.
- **No Anthropic key at the office:** a 401 at `api.anthropic.com` means an old BYOK key is still configured — clear the Anthropic field in Settings → Credentials (the runner auto-restarts).
- **Box upgrades:** `git pull && $DC build context-api workgraph-api platform-web && $DC up -d --no-deps context-api workgraph-api platform-web`.

> Related: [`laptop-split-deployment.md`](./laptop-split-deployment.md) (single-machine + BYOK variants), [`hybrid-laptop-deployment.md`](./hybrid-laptop-deployment.md) (full env reference).
