# Testing the Copilot and Anthropic gateways

Singularity runs **two independent LLM execution paths** that coexist by design:

- **Anthropic gateway** — the LLM Gateway (`:8001`) calls Anthropic for the
  workbench, agent stages, and every governed LLM call. Provider config lives in
  `.singularity/llm-providers.json` (`anthropic` + a deterministic `mock`).
- **Copilot CLI** — copilot-mode SDLC workflow stages are delegated to the GitHub
  Copilot CLI (`copilot -p --allow-all`), executed by `mcp-server` and captured as
  an auditable code-change receipt (diff + changed files + summary). See
  [`copilot-cli-executor.md`](copilot-cli-executor.md).

> **Invariant:** the workbench and agent runs **always** use the LLM gateway;
> **only** copilot-mode workflows use the Copilot CLI. The two never compete for
> the same stage.

---

## 0. Fresh clone + boot

```bash
git clone https://github.com/ashokraj2011/singularity-platform.git
cd singularity-platform

# Primary local dev path — boots all backend services + the unified Platform Web
# (:5180) + the local llm-gateway (:8001) and mcp-server (:7100).
bin/bare-metal.sh up
```

On a fresh clone the operator-owned LLM configs are gitignored and **auto-restored
from templates** at boot: `.singularity/llm-providers.json` ← `.json.default`,
`.singularity/llm-models.json` ← `.json.default`. No manual step required.

Docker alternative:

```bash
./singularity.sh up --profile llm-gateway --profile mcp
```

> Fresh-clone bootstrap is verified to build clean: `npm install` in
> `agent-and-tools/` (≈931 packages), then `tsc --noEmit` passes for both the
> merged `agent-service` (agents + tools) and `platform-web`.

---

## 1. Anthropic gateway (workbench + agent runs)

The `anthropic` provider reads its key from the `ANTHROPIC_API_KEY` env var
(`credentialEnv` in `llm-providers.json`); its default model is
`claude-sonnet-4-6`. `bin/bare-metal.sh` does **not** auto-source secrets, so
export the key **before** `up`:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or keep it in the gitignored secrets file and source it:
#   printf 'ANTHROPIC_API_KEY=sk-ant-...\n' > .env.llm-secrets
#   set -a && . ./.env.llm-secrets && set +a
bin/bare-metal.sh up
```

Verify:

```bash
curl -s localhost:8001/health        # gateway up
tail -f logs/llm-gateway.log         # watch Anthropic calls as you drive a run
```

Then open `http://localhost:5180/workbench`, run an agent stage. Confirm:
- `logs/llm-gateway.log` shows an Anthropic request, and
- `http://localhost:5180/cost` shows an `llm.call.completed` row with a `claude-*`
  model.

**Offline / no-key smoke:** the config ships a `mock` provider. Point a run at a
`mock-*` model to exercise the gateway path with no key or cost, then switch to
`anthropic` for the real call.

---

## 2. Copilot CLI (copilot SDLC workflows)

Copilot is the **executor for copilot-mode stages**: context-fabric dispatches the
`copilot_execute` MCP tool, and `mcp-server` runs `copilot -p "<task>" --allow-all`
in the materialized work-item sandbox, returning the `git diff` + summary as a
receipt. The CLI is the *agent* (it edits files itself), so the stage is delegated
wholesale rather than driven by a tool-call loop.

Prereq on the machine running `mcp-server`:

```bash
copilot --version                    # GitHub Copilot CLI installed + authenticated
```

Test with the seeded workflow (`workgraph-studio/apps/api/prisma/seed-sdlc-copilot.ts`,
"SDLC Copilot"):

1. Open `http://localhost:5180/workflows` and launch **SDLC Copilot**.
2. Attach a repository (e.g. a GitHub repo linked to a capability).
3. Run a coding stage. context-fabric routes the copilot-mode stage to
   `mcp-server`, which runs the Copilot CLI in the sandbox.
4. Watch `logs/mcp-server.log` for the `copilot_execute` tool-run and the returned
   code-change receipt.

---

## 3. Telling the two paths apart

| Signal | Anthropic gateway | Copilot CLI |
|---|---|---|
| Events (`/cost`, audit) | `llm.call.completed` (model `claude-*`) | `copilot_execute` tool-run + code-change receipt |
| Logs | `logs/llm-gateway.log` | `logs/mcp-server.log` |
| Who runs the model | LLM Gateway → Anthropic Messages API | GitHub Copilot CLI on the host |
| Used by | workbench, agent stages, governed LLM calls | copilot-mode SDLC workflow stages only |

A copilot-mode stage produces **no** `llm.call.completed` for its model step — the
CLI is the agent, and its work is captured as the receipt instead.

---

## Notes

- The two paths are orthogonal: you can run with **only** an Anthropic key (the
  default), **only** Copilot (copilot-mode workflows), or **both** — the invariant
  keeps them on separate stages.
- `ANTHROPIC_API_KEY` and any Copilot token belong in `.env.llm-secrets` (the
  gitignored credential file the secret-guardrail check expects), never in a
  broad `.env`.
