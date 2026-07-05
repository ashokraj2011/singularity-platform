# Singularity — End-to-End Demo Script

**The one-sentence pitch:** Singularity is a *governed* SDLC agentic platform — author a
workflow once, run it with agents + MCP tools under IAM governance, choose **any LLM at
runtime**, and — the part nobody else does — **export a half-finished run to Copilot CLI or any
tool**, do the work anywhere, then bring it back and the platform **verifies it in git** before a
human promotes it.

**The loop you're demoing:** `author → govern → run (any model) → export (any tool) → verify (git) → promote`

**Runtime:** ~30–35 min. Everything is local bare-metal. Default model everywhere is
**Claude Sonnet 4.6** (`claude-sonnet-4-6`).

---

## 0 · Pre-flight (do this 20 min before, not live)

- [ ] Postgres running locally; know your db user (macOS local is often `$USER` or `postgres`).
- [ ] `copilot` CLI on PATH (`command -v copilot`) — backs the `:4141` bridge.
- [ ] `.env.laptop` present (it is) with `COPILOT_MODEL=claude-sonnet-4-6` and your `COPILOT_PROVIDER_API_KEY` / `GITHUB_TOKEN` filled in.
- [ ] Ports free: `5180 8000 8001 8080 8100 3001 3003 3004 7100 4141`.
- [ ] `jq` installed (for the verify curls).
- [ ] Do **one full dry run** end-to-end the day before. Demos break; muscle-memory doesn't.

### Boot cheat-sheet (copy-paste, three terminals)

```bash
cd /Users/ashokraj/Downloads/copilotAnthropicRun/singularity-platform

# ── Terminal 1: the Copilot LLM bridge (OpenAI-compatible, backs GitHub Copilot CLI) ──
node bin/copilot-cli-server.js --port 4141

# ── Terminal 2: the whole platform (replace <db_user> with your Postgres user) ──
bin/bare-metal.sh up <db_user>
#   …wait ~30s, then verify:
bin/bare-metal.sh smoke

# ── Terminal 3: dial in the MCP runtime with Sonnet 4.6 as its default model ──
bin/mcp-runtime-setup.sh connect \
  --context-fabric-url http://localhost:8000 \
  --iam-user-id eee38875-fbde-4dbb-a68c-3f75df9cd5a8 \
  --runtime-id mcp-runtime-copilot-anthropic \
  --runtime-name mcp-runtime-copilot-anthropic \
  --copilot-token copilot-local \
  --copilot-base-url http://localhost:4141/v1 \
  --default-provider copilot \
  --default-model claude-sonnet-4-6
```

### Prove the model + runtime are live (say this out loud while it prints)

```bash
# Default model resolves to Sonnet 4.6:
curl -s http://localhost:8001/llm/models | jq '.[] | select(.default==true) | {id, provider, model}'
#   → { "id": "claude-sonnet-4-6", "provider": "copilot", "model": "claude-sonnet-4-6" }

# The laptop MCP runtime has dialed in:
curl -s http://localhost:8000/api/runtime-bridge/status | jq '{connected, runtimes}'

# One real round-trip through the model:
curl -sS http://localhost:8001/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model_alias":"claude-sonnet-4-6","messages":[{"role":"user","content":"Reply exactly: sonnet ready"}]}' \
  | jq -r '.choices[0].message.content'
```

> ⚠️ **Honesty note for you (not the audience):** the `:4141` bridge echoes back whatever
> `model` you send, so a 200 alone doesn't *prove* Sonnet answered. The round-trip above +
> the `/llm/models` default row are your real evidence. If a stage ever feels off-model, this
> is the first thing to check.

**Open the UI:** <http://localhost:5180> → log in as the super admin
(`LOCAL_SUPER_ADMIN_EMAIL` / bootstrap password from your env; the boot banner prints it).

---

## The URLs you'll drive (keep this tab-set open)

| # | URL | What it is | Demoed in |
|---|-----|-----------|-----------|
| 1 | `http://localhost:5180/identity` | IAM admin + governance authoring | Act 1, 2 |
| 2 | `http://localhost:5180/workbench` | Blueprint Workbench (design) | Act 3 |
| 3 | `http://localhost:5180/workflows` | Workflow designer **+ Runs cockpit** | Act 4, 7 |
| 4 | `http://localhost:5180/foundry` | Code Foundry | (optional) |
| 5 | `http://localhost:5180/agents/studio` | Agent Studio | (optional) |

---

## Act 1 · Identity & metadata — "everything here is governed" (~3 min)

**Say:** "Before an agent touches a repo or an LLM, the platform asks *who* and *what are they
allowed to do*. So we start with identity."

**Do — `:5180/identity`:**
1. **Create a Business Unit** → e.g. `Payments`.
2. **Create a Team** under it → `Payments-Core`.
3. **Create a User** → assign to the team.
4. **Create a Capability** → e.g. `code.write` (this is the token that later gates which tools /
   LLM an agent may use).
5. **Edit** one of them in place to show it's a full CRUD console, not read-only.

**Show:** the create → edit → delete controls on every row. **Say:** "This whole console —
create, edit, delete for BUs, teams, users, roles, capabilities, and MCP servers — is the
governance surface. Capabilities are the load-bearing part: they're the tenant/permission proxy
that the runtime enforces."

> ⚠️ Adapt names to whatever your instance already seeds; the point is the CRUD + capabilities,
> not the specific records.

---

## Act 2 · Pick the brain — LLM switching (~3 min)

**Say:** "Same governance decides *which model* runs. The platform default is Sonnet 4.6 — but
you can switch provider and model, and even override per-run."

**Do:**
1. Show the **model catalog** — `claude-sonnet-4-6` is the default, labelled *"Claude Sonnet 4.6
   — Default platform model."* Providers available: **Copilot, OpenAI, Anthropic** (+ openrouter,
   mock).
2. **Say:** "In Act 0 we wired the *laptop runtime* to Sonnet-4.6 through the **Copilot** bridge.
   Same model id, different provider path — the gateway resolves an *alias → provider + model* per
   touch-point (governed agent, workbench, chat, audit)."
3. **Foreshadow:** "And when we launch a run in a minute, you'll get to pick the model right there."

---

## Act 3 · Design the work — contract-first (~4 min)

**Say:** "Now the work itself. Nodes are contract-first: each one declares what it **produces**
and what it **consumes**, and the platform threads artifacts between them."

**Do — `:5180/workbench`** (open an existing blueprint or start one):
1. **Add a node.** Open its inspector.
2. **Artifacts come from templates** — show the artifact **template picker** pulling from the
   Artifact Studio catalog (not free-text).
3. **IN / OUT tabs** — flip between **OUT (produces)** and **IN (consumes)** on the node. "This is
   how we know a node's outputs vs its inputs — no ambiguity."
4. **Input inheritance** — connect an upstream node; its **outputs auto-appear as this node's
   inputs**. "You don't re-declare inputs by hand; downstream inherits upstream's contract."

**Show:** an artifact flowing from one node's OUT to the next node's IN.

---

## Act 4 · Run it — with the model *you* pick (~4 min)

**Say:** "Launch it. Notice the model picker — this is a per-run override that beats the node
default, the workflow default, and the routing table."

**Do — `:5180/workflows`:**
1. **Launch** the workflow.
2. In the launch dialog, use the **Model (optional)** picker → pick `claude-sonnet-4-6`
   (or pick a *different* provider/model to visibly prove runtime switching).
3. Watch it run: the **governed agent loop**, **MCP tool calls**, and — if the graph has one — a
   **GOVERNANCE_GATE** node pausing for human approval.

**Show:** the run advancing stage-by-stage; approve the governance gate live.

**Say:** "Everything the agent did just now went through IAM + the audit trail. Nothing off-leash."

---

## Act 5 · Take it anywhere — export the half-done run (~4 min)

**Say:** "Here's the part that's different. Say you want to finish this run in your own tool —
Copilot CLI, or literally anything. Download the run *as it stands*."

**Do:**
1. From the run, **Export → Copilot YAML** (or curl it):
   ```bash
   # $TOKEN = your IAM bearer; $RUN = the run/instance id from the URL
   curl -sL "http://localhost:5180/api/workgraph/workflow-instances/$RUN/export/copilot-yaml?fromPhase=next" \
     -H "Authorization: Bearer $TOKEN" | tee /tmp/run.yaml | head -60
   ```
2. **Show the YAML:** completed phases are inline with their **artifacts + diffs + commit SHAs**;
   remaining phases carry **runnable prompts** *and* the result post-back contract. "It's the whole
   run — work so far *and* what's left."
3. **Run it externally** — the one-liner the export prints:
   ```bash
   curl -L "http://localhost:5180/api/workgraph/workflow-instances/$RUN/export/copilot-runner.sh" \
     -H "Authorization: Bearer $TOKEN" | bash
   ```
   This executes the remaining copilot stages locally and **pushes a branch**.

**Say:** "Or hand that YAML to *any* tool or a human — the export is tool-agnostic. The one
non-negotiable: **push a branch**, because that's what we verify against."

---

## Act 6 · Come home — trust, then verify *in git* (~4 min)

**Say:** "When the external work posts back, the platform doesn't just take its word for it."

**What happens:** the runner POSTs to `…/export/copilot-results`. The platform ingests the
artifacts as **UNDER_REVIEW** + a **Receipt**, and computes an **advisory git-verify verdict**:

- **Integrity** — recompute `sha256` of each returned artifact vs what was reported.
- **Coverage** — are the artifact paths actually in the branch's changed-file set?
- **Pushed** — branch + commit present?
- **Status** — `PASSED` / `INCOMPLETE` / `UNVERIFIED`.

**Do / Show:** open the receipt (or the artifact panel) and show the **verdict** attached.

**Say:** "It's *advisory* — a human still promotes the artifacts. But they promote **with a
verdict in hand**: was a branch pushed, do the hashes match, does the changed-file coverage line
up. Trust, then verify — in git."

> ⚠️ **Honest boundary (built in on purpose):** `remoteVerified` is `false` — this checks the
> posted payload against the reported commit/coverage, it does not yet re-clone and diff the
> remote. That's the next hardening step, and the verdict says so rather than overclaiming.

---

## Act 7 · The cockpit & the paper trail (~2 min)

**Do — `:5180/workflows` (Runs):** the **full-width Runs cockpit** — every run, its stage, its
model, its governance state. Drill into one for the **audit trail**: which capability, which model,
which tool, which approval.

**Say:** "Every run is reproducible and accountable. That's the whole point — agentic speed,
enterprise governance."

---

## Close (30 sec)

> "So: we authored a contract-first workflow, governed *who* and *which model*, ran it with agents
> and tools — picking Sonnet 4.6 at launch — exported the half-done run to finish in an outside
> tool, pushed a branch, and the platform verified that work in git before a human promoted it.
> One governed loop, any model, any tool."

---

## Appendix A · Ports

| Port | Service | | Port | Service |
|------|---------|---|------|---------|
| 5180 | platform-web (**entry**) | | 8000 | context-fabric API |
| 8001 | LLM gateway | | 8080 | workgraph-api |
| 8100 | IAM API | | 3001 | agent-service (+tools) |
| 3003 | agent-runtime | | 3004 | prompt-composer |
| 7100 | mcp-server | | 4141 | Copilot CLI bridge |

## Appendix B · Troubleshooting (live-demo grade)

| Symptom | Fix |
|---------|-----|
| Model isn't Sonnet | `curl -s :8001/llm/models \| jq '.[]\|select(.default)'` — re-run the Act-0 `connect` if wrong. |
| Runtime not dialed in | `curl -s :8000/api/runtime-bridge/status \| jq` → restart Terminal-3 `connect`. |
| Bridge (`:4141`) dead | Terminal-1 `node bin/copilot-cli-server.js --port 4141` must stay running; `copilot` CLI must be on PATH. |
| A backend change isn't live | `bin/bare-metal.sh` picks up frontend on refresh; **Python/agent-runtime services need a restart** (`down` then `up`). |
| Tail a service | `bin/bare-metal.sh logs <service>` (e.g. `workgraph-api`, `llm-gateway`, `context-api`). |
| Something's wedged | `bin/bare-metal.sh smoke` to see what's red. |

## Appendix C · Teardown

```bash
bin/bare-metal.sh down          # stops the platform + sweeps its ports
# Terminal-1: Ctrl-C the copilot-cli-server
```

---
*Model default: `claude-sonnet-4-6` (Claude Sonnet 4.6). Entry: `http://localhost:5180`.*
