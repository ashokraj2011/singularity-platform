# Copilot CLI as executor (§13.4)

How Singularity runs **governed code stages on the GitHub Copilot CLI** when the
CLI is the only Copilot access (no `copilot-api` / function-calling). The CLI is
an *agent* — in `-p --allow-all` it edits files and runs commands itself and
returns **text**, not OpenAI `tool_calls` — so the cloud tool-call loop can't
drive it. Instead the platform **delegates the whole stage** to the CLI on the
laptop and captures the result as **auditable evidence**. This is the
`platform-handbook.md` §13.4 "Laptop Copilot Invocation" model.

## Pieces

| # | What | Where | Status |
|---|---|---|---|
| Chat path | OpenAI `/v1/chat/completions` backed by `copilot -p` | `bin/copilot-cli-server.js` | ✅ #161 — for chat/doc stages only |
| Slice 1 | run CLI in a git workspace, capture a code-change **receipt** (diff + files + summary) | `bin/copilot-execute.js` | ✅ #164 (proven on RuleEngine) |
| Slice 2 | attach to a WorkItem → **scoped session token** + platform-assembled prompt → run → `POST /complete` with the receipt | `bin/copilot-execute.js --work-item` | ✅ #165 (invocation `COMPLETED`) |
| Slice 3 | **heartbeats** every 20s during the run (liveness) | `bin/copilot-execute.js` | ✅ this change |
| Slice 4 | a **Develop-stage execution mode** so the SDLC workflow auto-dispatches to the laptop | platform (CF + workbench) | 🔵 designed below |

## Slice 4 — platform-side auto-dispatch (design)

Today you run `copilot-execute --work-item <id>` by hand. Slice 4 makes the
**stage run** create the invocation and wait for the laptop to finish.

### Stage config
Add `executor` to the loop/stage definition (alongside `agentRole`,
`toolPolicy`): `'cloud-loop'` (default) | `'direct-copilot'`. A stage marked
`direct-copilot` delegates to the laptop instead of running the cloud tool-loop.

### Hook point
`workgraph-studio/apps/api/src/modules/blueprint/blueprint.router.ts`
→ `POST /sessions/:id/stages/:stageKey/run` (line ~2252). Branch:

```
if (stage.executor === 'direct-copilot') {
  // instead of executeGovernedTurn(...) (the cloud loop):
  const inv = startLaptopInvocation(workItemId, actor, {
    mode: 'direct-copilot', capabilityId, agentTemplateId,
    task: assembledStagePrompt, repoUrl, branch,
  })                                   // already mints the scoped token + assembles the prompt
  markStageAwaitingLaptop(session, stageKey, inv.invocation.id)   // stage → AWAITING (not RUNNING the loop)
  return { status: 'AWAITING_LAPTOP', invocationId: inv.invocation.id }
}
```

### Laptop side (two options)
1. **Poll** (simplest): add `GET /api/laptop-invocations/pending` →
   `STARTED` invocations for the caller; a `bin/copilot-agent.js` loop picks them
   up, clones `repoUrl`, runs `executeTask`, `POST /complete`. (`copilot-execute`
   already does everything except the poll + clone.)
2. **Push**: dispatch over the existing laptop WebSocket bridge
   (`context-fabric/.../laptop_registry.py`) with a new `invocation-run` frame —
   reuses the per-user routing already built for `tool-run`/`model-run`.

### Completion → stage result
On `POST /laptop-invocations/:id/complete`, the existing
`completeLaptopInvocation` already writes a `work_item_event`. Slice 4 adds:
turn the receipt `payload` into the stage's **expected artifacts**
(`actual_code_change` from the diff, `developer_task_pack` from the summary) and
**advance the stage** (or pause for verdict) — i.e. resolve the `AWAITING_LAPTOP`
state with the captured evidence, same shape the cloud loop produces.

### Governance
Unchanged guarantees: scoped session token (slice 2), heartbeats (slice 3),
`work_item_event` receipts, and the diff as `actual_code_change` evidence. The
difference vs the cloud loop is *where* the edits happen (laptop CLI) — the
evidence trail is the same.

### Why it's not built yet
It mutates the stage lifecycle in a 6000-line router and only exercises on a real
box+laptop split (the cloud creates the invocation, the laptop completes it), so
it needs that environment to validate. Slices 1–3 are the laptop side and run
today; slice 4 is the cloud wiring.

## Run it today (slices 1–3)
```bash
# standalone
node bin/copilot-execute.js --task "<task>" --workspace /path/to/repo

# governed, against a WorkItem (scoped token + receipt + heartbeats)
node bin/copilot-execute.js --work-item <uuid> --workspace /path/to/repo \
  --platform http://localhost:8080/api --token <iam-jwt> --task "<task>"
```
