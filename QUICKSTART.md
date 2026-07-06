# Quickstart — fresh clone → running demo (Copilot / Claude)

The shortest reliable path from a clean machine to a launched workflow, using the
**Copilot bridge → Claude** LLM path. Portable: no hardcoded paths or DB user.

> Every trap this guide avoids was learned the hard way. Follow the two **Rules**
> in step 3 and it connects clean.

---

## 0 · Prerequisites (once per machine)

macOS / Homebrew:

```bash
brew install postgresql@16 pgvector node python@3.11 pnpm jq
brew services start postgresql@16
```

- **GitHub Copilot CLI** (`copilot`) installed and **logged in** — it backs the LLM.
  Run `copilot` once and sign in before step 3.
- Your Postgres role must be able to **create databases** (a normal local install can).

---

## 1 · Clone

```bash
git clone https://github.com/ashokraj2011/singularity-platform.git ~/singularity
cd ~/singularity
```

---

## 2 · Boot the whole stack

```bash
./bin/demo-up.sh
```

This is safe to re-run — it **self-cleans** any stale/orphaned processes first, then
boots. It **auto-detects your Postgres user** (`$USER`). Override if your role differs:

```bash
DB_USER=postgres DB_PASS=yourpass ./bin/demo-up.sh
```

Wait until every service prints `✓`.

---

## 3 · Wire the LLM (Copilot → Claude)

In a **second terminal**, start the bridge, then wire it into the gateway:

```bash
# Rule 1: start the bridge with NO --model.
#   (claude-sonnet-4-6 is a PLATFORM alias, not a real Copilot CLI model id —
#    pinning it makes the CLI reject every call. No --model = CLI uses its default.)
node bin/copilot-cli-server.js --port 4141        # leave this running

# Rule 2: wire with 127.0.0.1 (bare-metal), NOT host.docker.internal (Docker-only)
#         and NOT localhost (can resolve to IPv6 and refuse).
./bin/llm-use-copilot.sh --base-url http://127.0.0.1:4141/v1 --model claude-sonnet-4-6 --token copilot-local
```

Verify it's ready and actually answers:

```bash
curl -s localhost:8001/llm/models | jq '.[]|select(.id=="claude-sonnet-4-6")|{id,ready}'
#   → { "id": "claude-sonnet-4-6", "ready": true }

curl -s -X POST localhost:8001/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model_alias":"claude-sonnet-4-6","messages":[{"role":"user","content":"reply: ready"}],"max_tokens":8}'
#   → real text back
```

---

## 4 · Launch a workflow

Open **http://localhost:5180**, sign in `admin@singularity.local` / `Admin1234!`, then
on the launch screen (`Guided Launch`):

- **Capability:** `Default Demo Capability`  ← seeded + planner-active (**not** RuleEngineTestin)
- **Model alias:** `claude-sonnet-4-6`
- **Story:** any real sentence (≥ 8 chars)

Both prerequisite chips go green → **Launch SDLC Workflow**.

---

## The three rules that make Copilot "just work"

1. **Bridge with no `--model`** — pinning a platform alias the CLI doesn't have breaks it.
2. **Wire with `127.0.0.1`** — not `host.docker.internal` (Docker) or `localhost` (IPv6).
3. **Wire from the same clone you booted** — configs are per-clone.

(The runtime now hot-reloads the provider config, so wiring Copilot *after* boot is
picked up automatically — no restart needed.)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Anything wedged / weird | `./bin/free-all-ports.sh --deep` → back to zero, then re-run step 2 |
| `gpt-4o`/`claude…` "Missing credential" | Bridge not wired — re-run step 3 (`llm-use-copilot.sh`) |
| `"model … from --model flag is not available"` | You pinned `--model` on the bridge — restart it with **no** `--model` |
| `"provider copilot: blocked by allowlist"` | Config not yet reloaded — re-run `llm-use-copilot.sh`; it now takes effect without a restart |
| `"Workflow API not reachable"` | `workgraph-api` (`:8080`) down — re-run `./bin/demo-up.sh` |
| Launch model list shows only `mock-*` | Copilot not wired / bridge down — check step 3 |
| Just rehearsing the flow (no real LLM) | Set model alias to `mock-fast` — launches with canned output |

Teardown: `./bin/demo-down.sh` (or `./bin/free-all-ports.sh --deep`). Postgres is always left running.
