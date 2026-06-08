# Deployment topology — cloud control plane, variable MCP/LLM placement

Status: **design / proposal**. Companion to `singularity-desktop-design.md`
(client) and the Connection Keys feature (PR #143).

## 1. Principle

The **control plane is always cloud**. Only two pieces of *compute* have a
choice of where they run:

- **MCP** — the tool/sandbox runner (executes tools, fs, git on a workspace).
- **LLM** — the model calls (completions).

```
ALWAYS CLOUD (control plane)            VARIABLE PLACEMENT (compute)
┌────────────────────────────────┐     ┌───────────────┬───────────────┐
│ context-fabric (orchestration) │     │     MCP       │      LLM       │
│ workgraph · IAM · agent-runtime│ ──► │ cloud │ laptop│ cloud │ laptop │
│ audit · prompt-composer · DBs  │     └───────────────┴───────────────┘
└────────────────────────────────┘
```

Everything except MCP and LLM stays in the cloud. MCP and LLM can each be
**cloud** (shared/enterprise) or **laptop** (the user's own machine), chosen
per user / per deployment.

## 2. Placement modes

| Mode | MCP (tools) | LLM (model) | Use case | Status |
|---|---|---|---|---|
| **Enterprise / full cloud** | cloud (shared `mcp-server :7100`) | cloud (central `llm-gateway`) | locked-down orgs; central LLM gateway | ✅ default today |
| **Mixed** | **laptop** | cloud | run tools against the user's real repo/files, model stays central | ✅ works now (current laptop mode) |
| **Full BYO laptop** | laptop | **laptop** | user brings their own model (local Copilot/Ollama) **and** tools | ⚠️ LLM-on-laptop not built |

Two of the three modes already work. The third needs the **LLM-on-laptop**
dispatch path (§5).

## 3. The switch: a PAT (device token)

Placement is driven by a **device token** (a.k.a. Connection Key / PAT) — a
`kind:"device"` JWT, `sub = user_id`, scoped + revocable. Its presence on the
laptop bridge is what makes routing prefer the laptop.

**Configurable three ways (all shipped):**
- **Web** — Operations → Connection Keys (mint/copy/revoke).
- **CLI** — `singularity-mcp login` / `start --token <key>`.
- **Electron** — Singularity Desktop → Pair (`clients/singularity-desktop/`).

Same token, same `(user_id, device_id)` registry, same per-user isolation.

## 4. MCP placement (DONE)

- The laptop runs `mcp-server` in `LAPTOP_MODE`, connects to
  `…/api/laptop-bridge/connect` with the device token → context-fabric registers
  `(user_id, device_id)`.
- Dispatch (`governed/dispatch.py`): when a run has `prefer_laptop` and a
  matching `run_context.user_id`, tool-run frames go to that user's laptop; else
  the shared cloud `mcp-server :7100`.
- The bridge today carries **only `tool-run` frames** (`laptop_registry.py`
  `frame_type="tool-run"`).

## 5. LLM placement (THE GAP) — `model-run` over the bridge

Today **all** model calls go cloud-side: `context-fabric → llm-gateway →
provider`. The `llm-gateway` has no per-user/laptop concept. To let the cloud
use the **user's laptop LLM** (e.g. their local Copilot bridge on `:4141`), add
a `model-run` frame that mirrors `tool-run`:

```
cloud CF ──(model-run frame: {messages, model, …})──► laptop mcp-server
                                                          └─► local LLM (Copilot :4141 / Ollama / …)
         ◄──────────── completion ──────────────────────
```

Why the lift is small:
- The laptop `mcp-server` **already has LLM plumbing** (`src/llm/client`,
  `configuredDefaultModel`, gateway-provider cache) — it can already point at a
  local OpenAI-compatible endpoint.
- The bridge framing already exists for tools; `model-run` is a second frame
  type alongside `tool-run`.

Work items:
1. **Bridge** — `dispatch_model_via_laptop()` in `laptop_registry.py`
   (`frame_type="model-run"`), mirroring `dispatch_tool_via_laptop()`.
2. **CF call site** — where CF calls the gateway, branch on `prefer_laptop_llm`
   + a connected laptop advertising LLM → route over the bridge instead.
3. **Laptop handler** — `mcp-server` laptop mode handles `model-run` by calling
   its configured local LLM endpoint and returning the completion.
4. **Capability advertisement** — on connect (`hello`), the laptop declares
   `{ serves: ["tools", "llm"] }` so CF knows it can take model frames.
5. **Privacy note** — a *local* model keeps prompt data on-device (a privacy
   win); a *local Copilot bridge* still calls out to GitHub. Surface which.

## 6. The placement policy (ties it together)

A small policy object decides placement, evaluated per run:

```
placement = {
  mcp: 'cloud' | 'laptop',   // default 'cloud'; 'laptop' when paired + prefer_laptop
  llm: 'cloud' | 'laptop',   // default 'cloud'; 'laptop' only in full-BYO mode
}
```

Resolution order (later overrides earlier):
1. **Deployment default** — e.g. `PLACEMENT_DEFAULT=cloud`.
2. **Enterprise override** — `ENTERPRISE_LLM_GATEWAY=true` ⇒ **force `llm:cloud`**
   (and typically `mcp:cloud`). This is the "if it's an enterprise LLM gateway,
   MCP and LLM are in cloud" rule — one flag; the laptop is never dispatched to,
   even if paired.
3. **Per-user / per-capability** preference.
4. **Per-run** `prefer_laptop` / `prefer_laptop_llm` (or the deployment-wide
   `PREFER_LAPTOP_LLM=true` env, handy for testing / a homogeneous BYO fleet),
   gated by an actually connected laptop advertising the capability.

Fallbacks are always safe: laptop selected but not connected → cloud.

## 7. Security & consent

- MCP-on-laptop: scopes + allowed-paths + approval (see desktop design §6).
- LLM-on-laptop: the consent question is **data egress** — prompts/code go to
  the laptop's model. Local model = on-device; local Copilot = egress to GitHub.
  The Electron app should show the active LLM target + let the user disable
  laptop-LLM per capability.
- Enterprise mode: policy can **disable** laptop placement org-wide regardless of
  user pairing (compliance).

## 8. What's done vs. to-build

| Piece | Status |
|---|---|
| PAT mint/consume (web + CLI + Electron) | ✅ #143, #144 |
| MCP-on-laptop (tool-run dispatch, per-user) | ✅ existing |
| Enterprise full-cloud (shared mcp + central gateway) | ✅ default |
| **LLM-on-laptop (`model-run` dispatch)** | ✅ §5 — shipped (P-c) |
| **Placement policy + enterprise override** | ✅ §6 — shipped (P-b) |
| Multi-instance CF laptop registry (sticky/shared) | ⛏ scale follow-up |

## 9. Suggested build order

- **P-b** — placement policy + enterprise override (small; the control surface).
- **P-c** — LLM-on-laptop `model-run` path (bigger; completes full-BYO).
- Then the desktop app surfaces the LLM target + per-capability toggle.
