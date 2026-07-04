# Multi-Runtime Registration & Routing (mcp + llm · laptop + cloud)

> **Scope.** This complements two existing docs — [`deployment-topology.md`](deployment-topology.md)
> (placement *modes*) and [`bare-metal-cloud-laptop-runtime.md`](bare-metal-cloud-laptop-runtime.md)
> (setup, secrets, JWT keying). It focuses on the part those don't cover: how the
> Context Fabric **runtime-bridge registry** connects to and routes across
> **multiple** mcp/llm runtimes, the **one-token-per-runtime** identity rule, and the
> duplicate-id failure mode that motivated this doc.

## TL;DR

- The bridge is a **registry, not a single connection** — multiple mcp *and* llm
  runtimes, across multiple users/tenants, are a first-class capability.
- A frame is routed by **(user / tenant) → capability tags → frame type**, and the
  **first** eligible runtime wins (no load-balancing — see §6).
- **Hard rule:** every runtime needs a **unique `runtime_id`, carried in its own
  IAM-minted token.** Identity is *token-authoritative* — the client hello is
  advisory. Two runtimes sharing an id evict each other in a loop (§5).

---

## 1. The registry and the routing decision

Runtimes connect to CF over a WebSocket (`/api/runtime-bridge/connect`) and are
held in an in-memory registry keyed **`user_id → device_id → connection`**
([`laptop_registry.py`](../context-fabric/services/context_api_service/app/laptop_registry.py)).

`select_runtime()` picks the connection for each outbound frame:

1. **user-owned** runtime for the run's user, else
2. a **tenant/shared** runtime for the run's tenant.

It never falls back to another user's runtime. Eligibility (`_matches`) requires:

- `frame_type ∈ conn.supported_frame_types`, **and**
- requested `capability_tags ⊆ conn.capability_tags`, **and**
- tenant compatible (a tenant-bound request won't go to a different tenant's runtime).

These are **runtime placement tags** only. Context Fabric does not automatically
turn a governed business `capability_id` into a runtime tag, because generic MCP
runtimes minted by the setup scripts advertise broad tags such as `mcp`,
`tools`, and `llm`. When a run must be constrained to a specialized runtime,
set `runtime_capability_tags` / `runtimeCapabilityTags` explicitly in the run
context.

### Frame type ↔ what serves it

| Frame | Purpose | Served by a runtime advertising |
|-------|---------|--------------------------------|
| `tool-run` | execute one governed tool (apply_patch, run_command, copilot_execute, …) | `tools` / `mcp` |
| `model-run` | place an LLM call on the runtime (calls its local gateway/provider) | `llm` |
| `code-context` | build the repo code-context package | `mcp` |
| `source-tree` / `source-file` | repo discovery for capability bootstrap — list a repo's tree / fetch a file via the runtime's GitHub egress | `mcp` |
| `invoke` | legacy whole-loop drive | `mcp` |

So **tools and models are routed independently** — by frame type + capability tag —
even though they often live on the same runtime.

`source-tree`/`source-file` let a **cloud control-plane** service (agent-runtime
capability bootstrap) discover a repo through the requesting user's laptop runtime
— so repo ingestion works in the cloud+laptop split, where the cloud has no
co-located mcp HTTP. agent-runtime POSTs `/api/runtime-bridge/source/{tree,file}`
on CF (service-token auth, `user_id` in the body); CF relays the frame to that
user's runtime, which fetches from GitHub with its **local** token. Any direct
`MCP_SERVER_URL` path is debug compatibility and must be enabled explicitly with
`RUNTIME_HTTP_FALLBACK_ENABLED=true`; normal runtime traffic is WebSocket-first
and fails closed when no eligible runtime is connected.

All **HTTP control-plane endpoints** under `/api/runtime-bridge/*` that dispatch
or inspect runtime routing require `X-Service-Token` by default, even in local
development where `/execute` may be relaxed for demos. This includes status,
diagnostics, source discovery, tool-run, branch finalization, and worktree file
write routes. Use `/health` for unauthenticated liveness; use authenticated
status for runtime inventory because it includes user/runtime identity.
For a purely local one-off debug session only, `RUNTIME_BRIDGE_ALLOW_UNAUTHENTICATED_HTTP=true`
can temporarily disable that HTTP guard outside production-class environments;
do not use that setting for shared laptops, office networks, or cloud installs.
This auth escape hatch does not mean direct MCP HTTP fallback is enabled; mutating
routes such as branch finalization and worktree writes still require
`RUNTIME_HTTP_FALLBACK_ENABLED=true` before they will call `MCP_SERVER_URL`.

Runtime frames and response parts are bounded by the bridge payload ceiling
(`16 MiB` today). Context Fabric rejects oversized `hello` frames before JSON
parsing, closes oversized post-registration WebSocket frames with a WebSocket
`1009` close, and rejects oversized `response.payload` or `response.error`
bodies with `RUNTIME_RESPONSE_TOO_LARGE`. Runtime `response.request_id` values
must be nonblank strings of at most `128` characters. Malformed non-object
`response.error` frames are normalized to `INVALID_RUNTIME_ERROR` so callers
fail deterministically instead of timing out on a popped pending future.
Outbound Context Fabric dispatch frames are checked against the same ceiling
before they are written to the runtime socket; oversized requests fail as
`RUNTIME_FRAME_TOO_LARGE` and do not leave a pending request behind.
MCP also checks runtime-to-Context-Fabric frames before socket writes; oversized
response payloads are replaced with a compact `RUNTIME_RESPONSE_TOO_LARGE`
response for the same request id.
JSON frames must decode to objects; arrays, strings, numbers, and `null` are
rejected during hello or ignored as malformed live frames.
On the runtime side, MCP bounds bridge request ids to `1..128` characters and
decodes bridge-to-runtime frames with safe parsing; malformed known frame types
are ignored as invalid frames instead of throwing into the WebSocket message
handler.

---

## 2. Identity: one token per runtime (token-authoritative)

CF derives **all** identity/routing fields — `user_id`, `tenant_id`,
`runtime_id`, `runtime_type`, `device_name`, `capability_tags`, `shared` — from
the **verified JWT claims** when those claims exist. The client hello is advisory
metadata (health, supported_frame_types, and legacy display fallbacks) and any
hello field that conflicts with a claim is **logged and ignored**
([`laptop_bridge.py` security note](../context-fabric/services/context_api_service/app/laptop_bridge.py)).
This is deliberate: otherwise any holder of a valid runtime token could register
as another user/tenant and have work misrouted to them.

Consequence: **uniqueness and capabilities must live in the token**, not in an env
var the runtime echoes in its hello.

```
kind=runtime · sub=<iam-user-id> · runtime_id=<UNIQUE per runtime>
runtime_type=mcp · exp=<numeric unix seconds> · capability_tags=[…]
allowed_frame_types=[…] · (optional) tenant_id, shared
```

`kind=runtime` tokens must carry a nonblank `runtime_id` or `device_id`;
Context Fabric rejects runtime tokens that only carry `sub`. This prevents every
runtime for a user from collapsing onto the same registry slot. **Always mint a
distinct `runtime_id`.**
Token identity/display claims are bounded to IAM-compatible lengths
(`runtime_id`/`device_id`/tenant/user ids, `runtime_type`, and `device_name`);
oversized signed claims are rejected instead of being stored or exposed in
Operations.
`exp` is mandatory and must be a JWT NumericDate; Context Fabric rejects missing,
string, or already-expired expiries so runtime tokens cannot become unbounded
bridge credentials.
Runtime JWTs are capped at `16 KiB`, and both the decoded JWT header and payload
must be JSON objects before claims are trusted.
`allowed_frame_types` is also mandatory for `kind=runtime` tokens and must include
recognized frame names; it is the token-side upper bound for what
`hello.supported_frame_types` may advertise.
`capability_tags` are token-authoritative and canonicalized before routing:
blank values are dropped, duplicates are removed, and count/length are bounded.
Revocation checks use the token's `device_id` claim, falling back to `runtime_id`
for runtime-only tokens, and never trust the hello frame for revocation identity.

---

## 3. Supported shapes

**(a) One combined laptop runtime (recommended for "mcp+llm on laptop").**
`capability_tags=[mcp,tools,llm]`, `supported_frame_types=[tool-run,model-run,code-context,invoke]`.
The cloud routes both tool execution and LLM calls to the same connection.

**(b) Split mcp-only + llm-only runtimes.**
mcp runtime: `tags=[mcp,tools]`, `frames=[tool-run,code-context]`. llm runtime:
`tags=[llm]`, `frames=[model-run]`. Each with its **own** `runtime_id` + token.
`select_runtime` sends tool-runs to the first, model-runs to the second.

**(c) Multi-user fan-out.** Each developer's laptop registers under *their* IAM
`user_id`; the cloud routes each user's run to their own laptop. N laptops, one
cloud control plane.

**(d) Shared tenant runtime.** A runtime minted with `shared=true` + a `tenant_id`
serves any user in that tenant (used after the user-owned lookup). Lets you blend
per-user laptops with a shared cloud runtime for the same tenant.
`shared` is parsed strictly: boolean `true` or true-like strings such as
`"true"`/`"1"` enable tenant sharing; `"false"`/`"0"`/`"no"` do not. A token may
also use `runtime_scope=tenant` or `runtime_scope=shared`.

---

## 4. Placement: who decides laptop vs cloud

The governed loop always runs in the **cloud**; CF decides **per call** whether to
place the LLM call / tool call on a laptop runtime via the placement layer
(`governed/placement.py` → `llm_laptop_target`, `runtime_tenant_target`,
`runtime_capability_tags`; consumed in `governed/turn.py`). When a laptop serves
`model-run`, `call_gateway_chat` dispatches the model call over the bridge instead
of the cloud gateway. See [`deployment-topology.md` §5–6](deployment-topology.md)
for the placement policy and the model-run path.

---

## 5. Failure mode: duplicate `runtime_id` → the "replaced" storm

**What happened (incident, 2026-06-28).** `bin/bare-metal.sh` mints the runtime
token against a hardcoded `SINGULARITY_RUNTIME_ID=baremetal-mcp-runtime`. Three
checkouts (`adoptionRun`, `julyRun`, `testAgain`) were running at once, all minting
for the **same user + same `baremetal-mcp-runtime`** → all mapping to one registry
slot `(user, baremetal-mcp-runtime)`.

`register()` closes any existing connection for that slot with `reason="replaced"`
and **fails its in-flight calls**:

```python
existing = by_device.get(conn.device_id)
if existing is not None and existing.ws is not conn.ws:
    await existing.ws.close(code=1000, reason="replaced")
    self._fail_pending(existing, "runtime replaced by a new connection")
by_device[conn.device_id] = conn
```

With ~38 mcp processes thrashing one slot (~2,400 disconnects), CF could never
hold a stable connection → tool/model dispatch failed → the SDLC workbench loop
500'd. **mcp also never bound `:7100`** because it was in dial-in mode, which is
expected (it talks to CF over the bridge, not HTTP).

**Detection.** In `logs/mcp-server.log`: a healthy runtime shows **one**
`registered with bridge`; a collision shows a repeating
`WS closed … reason: "replaced"` loop.

**Fix.** One unique `runtime_id` per runtime (and don't run overlapping stacks
against one CF). The bare-metal hardcoded default should become unique-per-stack
(e.g. a UUID persisted in `.singularity/runtime-id`, used to mint the token) — a
small, recommended change.

---

## 6. Known limitation: first-match, not load-balanced

`select_runtime` returns the **first** eligible runtime for a user — it does not
round-robin or load-balance. So running **two identical** runtimes for one user
does not split load; one effectively wins. To steer work deliberately, **give
runtimes distinct `capability_tags`** (e.g. `tools` on one, `llm` on another)
rather than two identical ones, then request those tags with
`runtime_capability_tags` in the run context. Capability-weighted / round-robin
selection across identical runtimes is a future enhancement, not current
behavior.

---

## 7. Recommended setup for "mcp + llm on laptop, rest in the cloud"

1. **One combined laptop runtime** advertising `[mcp,tools,llm]` (simplest; the
   cloud routes both tools and models to it).
2. **Unique `runtime_id`**, minted into the runtime's **own** IAM token (via the
   Portal "register runtime" flow, or `bin/mcp-runtime-setup.sh`). Never reuse one
   token / id across machines.
3. **Provider keys + `GITHUB_TOKEN` stay on the laptop** (`.env.llm-secrets`);
   never copied to the cloud — see [`bare-metal-cloud-laptop-runtime.md`](bare-metal-cloud-laptop-runtime.md).
4. **Cloud** runs CF / workgraph / IAM / composer / audit / DBs; **placement**
   routes model + tools to your laptop.
5. Adding more runtimes later → each gets a **distinct id + token + capability tags**.

---

## 8. Code map

| Concern | File |
|---|---|
| Registry + routing (`select_runtime`, `_matches`, `register`) | `context-fabric/.../app/laptop_registry.py` |
| Bridge auth + token-authoritative identity | `context-fabric/.../app/laptop_bridge.py` |
| Runtime client (hello, `ensureDeviceId`, mode branch) | `mcp-server/src/laptop/relay-client.ts`, `mcp-server/src/index.ts` |
| Placement (laptop vs cloud, per call) | `context-fabric/.../app/governed/placement.py`, `governed/turn.py` |
| Launch scripts | `bin/bare-metal-runtime.sh`, `bin/laptop-bridge.sh`, `bin/mcp-runtime-setup.sh` |
