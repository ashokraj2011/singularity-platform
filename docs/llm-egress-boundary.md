# LLM egress boundary

**What this document is.** The platform's rule is that every LLM request goes
through prompt-composer, context-fabric, and a task-tagged LLM gateway. That rule
holds for cloud-side execution. It cannot hold for generation that happens on a
user's laptop, because the platform does not own the process, the credential, or
the network path.

This document records exactly where the line falls, what sits on each side, and
which questions are still open. It is descriptive, not aspirational: everything
below was re-verified against `main` at `90eb9fb9`, with file references. Where
something could not be verified from this repository, it says so rather than
guessing.

For this document, **INSIDE** means gateway-governed and centrally auditable.
Context Fabric's direct provider hatch is CF-controlled, but it is **outside the
LLM gateway boundary** because it bypasses gateway task tags, gateway audit, and
gateway cost attribution.

---

## The line

**Inside the boundary** — the platform composes the prompt, governs the loop,
tags the call, and audits it centrally.

**Outside the boundary** — the platform decides *what work to ask for* and
*receives the result*, but the generation itself runs on a machine and a
credential the user controls. The platform cannot see the prompt that reached the
model, cannot enforce a model choice, and has no cost record.

The boundary is not a defect to be closed. A laptop-local model is the point of
the laptop-local path: it exists so code and prompts need not leave the machine.
What matters is that the boundary is **explicit**, so nobody reads a green
governance dashboard and believes it covers work that happened outside it.

---

## Paths

### 1. Cloud governed execution — INSIDE

Agent turns dispatched through context-fabric to the cloud LLM gateway.

- Composed by prompt-composer, grounded by context-fabric.
- Tagged `agent_turn` and audited at the gateway.
- Entry: `context-fabric/services/context_api_service/app/governed/llm_client.py`
  (`_build_chat_body` sets `task_tag`); mcp-server's leg sets it at
  `mcp-server/src/llm/client.ts`.

This is the only path where the full rule holds end to end.

### 2. Context Fabric direct LLM — CF-controlled, outside the gateway boundary

`llm_route=context_fabric_direct` opens a provider socket from inside CF,
skipping the gateway.

- **Disabled unless `CF_ALLOW_DIRECT_LLM` is set.** A node that requests it while
  the hatch is shut is redirected to the gateway, not refused.
- Hardened when open: credential-env allowlist, custom-base-URL allowlist, host
  allowlist, private-host block (`CONTEXT_FABRIC_DIRECT_LLM_*` in
  `context-fabric/services/context_api_service/app/governed/direct_llm_client.py`).

### 3. Laptop-local model-run — OUTSIDE (two sub-cases)

When a run prefers the laptop, context-fabric short-circuits **before** the cloud
gateway (`llm_client.py`, the `runtime_requested` branch) and sends a `model-run`
frame to the laptop. What serves the model there depends on local configuration,
and the two cases differ enormously:

**3a — real gateway on the laptop.** `bin/laptop.sh` runs the *same* gateway
service locally. Alias resolution, provider allowlisting and audit all behave
normally — the audit record is simply written on the laptop rather than in the
cloud.

**3b — desktop Copilot shim.** When the desktop app's `localLlmEnabled` is on, it
**does not start the real gateway at all** and points `LLM_GATEWAY_URL` at a
~45-line translator (`clients/singularity-desktop/src/gateway-shim.js`) which
forwards to a local Copilot bridge. No auth, no rate card, no cost, no audit.

> **Alias handling in 3b.** The desktop now maps the provider-neutral `copilot`
> and `default` aliases to the configured local model. Other non-empty aliases
> are passed through as concrete upstream model ids; they no longer silently
> collapse to the default. If the local bridge does not support that model, it
> returns an upstream error instead of producing a misleading receipt.

### 4. Copilot-as-agent (`copilot_execute`) — OUTSIDE

The platform spawns the Copilot CLI (`copilot -p <task> --allow-all`) and takes
its diff. The CLI runs the entire coding loop internally.

- The platform passes **no model flag**; model choice belongs to the CLI and its
  environment.
- No per-tool governance mid-run. The tool says so on its own receipt:
  `in_loop: false`, `approval: "post_hoc"`, `risk_level: "HIGH"`.
- Copilot is deliberately **absent** from the gateway provider catalog
  (`llm_gateway_service/app/provider_config.py`) — this is by design, not an
  oversight.
- Levers that do apply: the prompt, a wall-clock timeout, a post-hoc diff/size
  bound, and `allow_all` (which callers may downgrade).

### 5. Copilot BYOK provider configuration — OUTSIDE, and unvalidated

`COPILOT_PROVIDER_TYPE` / `COPILOT_PROVIDER_BASE_URL` / `COPILOT_PROVIDER_API_KEY`
/ `COPILOT_MODEL` are **written by the platform and never read by it**. They are
exported into the environment the Copilot CLI inherits.

The shipped defaults point at Anthropic directly with a user-supplied key
(`.env.laptop.example`, `clients/singularity-desktop/src/main.js`, which reads the
key from the OS keychain). They are laptop/bare-metal only — never set in any
compose file.

> **Asymmetry worth knowing.** The CF direct path (§2) validates its base URL
> against a host allowlist and blocks private hosts. `COPILOT_PROVIDER_BASE_URL`
> has **no allowlist, no host check, and no validation** anywhere in the platform.
> Whatever URL is set is what the CLI is told to use.

### 6. Other external surfaces

Smaller, but real:

- `mcp-server/src/tools/copilot-headless.ts` — `gh copilot suggest` / `explain`
  via the `gh` CLI's own auth. Read-only (returns text, never executes).
- `singularity-desktop/electron/main.cjs` — a `desk:copilot:start` IPC that
  spawns the Copilot CLI with **caller-supplied args and caller-supplied env
  merged over the process environment**, gated only by a local-action prompt.
- `bin/copilot-execute.js` — a standalone CLI variant of §4.

---

## What the governance signals actually mean

Three signals are easy to over-read. Stated plainly:

**A passing `bin/check-llm-gateway-single-source.sh` does not mean "everything
goes through the gateway."** The guard **allowlists** the three known
direct-provider files by path (`direct_llm_client.py`,
`DirectLlmTaskExecutor.ts`, `DirectLlmToolLoop.ts`). It enforces *no new direct
paths*. That is a sound design, but the green tick is a statement about drift,
not about coverage.

**Gateway audit covers gateway traffic only.** Paths 3b, 4, 5 and 6 produce no
gateway record at all. Path 3a produces one on the laptop; whether those records
ship to the central audit service **has not been verified** — do not assume they
do.

**`estimated_cost` is not total spend.** Anything outside the boundary spends a
user's own credential and is invisible to platform cost reporting. The 3b shim
explicitly reports `estimated_cost: 0`.

---

## Controls

| Path | Control | Default |
|---|---|---|
| §2 CF direct | `CF_ALLOW_DIRECT_LLM` | **off** |
| workgraph direct | `WORKGRAPH_ALLOW_DIRECT_LLM` — refuses direct provider egress from `DIRECT_LLM_TASK` and the direct tool loop | **allowed** (no alternative egress exists yet, so off would break those nodes rather than reroute them) |
| §3 laptop | `ENTERPRISE_LLM_GATEWAY=true` — hard kill switch, laptop never dispatched | off |
| §3 laptop | `PREFER_LAPTOP_LLM` (fleet), `run_context.prefer_laptop_llm` (per run) | off |
| §3 laptop | `RUNTIME_HTTP_FALLBACK_ENABLED` — when off, a missing runtime fails loudly instead of silently using the cloud | off |
| §3b shim | desktop settings `localLlmEnabled`, `copilotBaseUrl`, `localModel` | user-controlled, **no server-side override** |
| §4 copilot_execute | `allow_all` per call; `COPILOT_BIN`; timeout caps | `allow_all` on |
| §5 BYOK | none — no validation of any `COPILOT_PROVIDER_*` value | — |

**`ENTERPRISE_LLM_GATEWAY=true` is the single switch that pulls generation back
inside the boundary.** It forces cloud MCP + cloud LLM and never dispatches to a
laptop. Deployments that must not have model traffic leaving the gateway should
set it.

There is **no control that disables `copilot_execute`.** It is unconditionally
registered and `requires_approval: false`. See *Open questions*.

---

## Open questions

Decisions, not tasks — each needs a human call:

1. **Is `COPILOT_PROVIDER_BASE_URL` acceptable unvalidated?** Today any URL can be
   set, with the user's key, and the platform neither reads nor checks it. Options:
   accept (it is the user's machine and credential), add a host allowlist mirroring
   the CF direct path, or refuse to launch when it points somewhere unexpected.

2. **Should `copilot_execute` be disableable?** A deployment that wants all
   generation inside the boundary currently cannot turn it off. An
   `MCP_COPILOT_EXECUTE_ENABLED` flag would make that posture expressible.

3. **Does laptop-gateway (3a) audit reach the central service?** Unverified. If it
   does not, 3a is closer to 3b than this document's framing implies, and the
   table above should be revised.

4. **Should `GATEWAY_REQUIRE_TASK_TAG` be turned on?** Now that context-fabric's
   governed loop tags its calls, the remaining untagged callers should be swept
   before flipping it.

---

## Could not be verified from this repository

Stated so nobody treats them as established:

- **Whether the Copilot CLI honours `COPILOT_PROVIDER_*` at all.** The binary is
  not vendored here. The platform's *intent* is well documented (including a
  preflight warning that a missing Anthropic key will cause 401s), but the CLI's
  actual behaviour is not observable from this source tree.
- **What serves `:4141`** when it is not `bin/copilot-cli-server.js`. The shim
  refers to a third-party `copilot-api`; if a user runs something else there,
  egress is entirely unknown to the platform.
- **Whether laptop-local gateway audit records ship centrally** (open question 3).
- **Whether `GATEWAY_REQUIRE_TASK_TAG` is set in any live deployment.**
