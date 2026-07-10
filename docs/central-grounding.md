# Central grounding (Workstream D)

Goal: run **all** capability grounding server-side so it never depends on the
laptop / mcp dial-in bridge. The knowledge half (embeddings, distillation) is
already central-capable; this doc covers the remaining piece — the **code /
workspace** half — plus the transport that landed with this workstream.

## What shipped (D1 + D2)

- **D1 — direct-to-gateway transport** (`agent-and-tools/packages/shared/src/llm-gateway/client.ts`).
  Set `LLM_GATEWAY_URL` (+ `LLM_GATEWAY_BEARER`) and `llmEmbed` / `llmRespond` call the
  central LLM gateway over HTTP directly, skipping the `mcp-server` relay. Grounding
  embeddings/distillation then go `agent-runtime | prompt-composer → gateway → provider`
  with **no dependency on the mcp/laptop dial-in bridge**. Secrets stay centralized at
  the gateway — never put provider keys in caller services. Unset → the mcp relay
  (default); mock mode still wins. Gateway responses are wire-identical to
  `EmbeddingsResponse` / `ChatCompletionResponse`, so it is a passthrough.
  Requires an embedding-capable provider at the gateway — see Workstream A
  (`bin/check-embedding-provider.py`, the `anthropic`-can't-embed landmine).
- **D2 — code-grounding clarity** (`agent-and-tools/apps/agent-service/src/tool/routes/internal-tools.ts`).
  `search_symbols` now distinguishes "no central code embeddings indexed" (the default —
  `EXTRACTOR_MODE=off`) from "no match", pointing callers at the runtime's local AST
  index (`find_symbol` / `get_symbol`). Resolves the confusing empty-result behaviour of
  the central-code-embeddings-vs-lexical-AST bifurcation.

## Eager central materialization at onboard (D3 — implemented, opt-in)

Previously the code half of grounding (the AST index) was built **lazily on the runtime**
(often the laptop) on the first workflow run. It is now wired to run centrally + eagerly at
onboard, opt-in via `GROUND_CODE_AT_ONBOARD`:

**How it's wired (shipped):**
- mcp-server endpoint **`POST /mcp/source/ground`** (`mcp-server/src/app.ts`): clone via
  `ensureWorkspaceSource` (brokered or static token) → `indexWorkspace` (AST index) →
  fire-and-forget `reportFingerprintToAgentRuntime` + `reportAstIndexBuiltToAgentRuntime`
  callbacks (stamp `astIndexedAt` + the drift baseline) — the same materializer/indexer/
  report path the per-workitem `code-context/build` uses.
- agent-runtime trigger (`capability.service.ts` `triggerCentralCodeGrounding`, gated by
  `GROUND_CODE_AT_ONBOARD`, fired fire-and-forget from both bootstrap paths): POSTs the
  capability's primary non-local repo to `MCP_SERVER_URL/mcp/source/ground` — DIRECT to a
  central mcp-server, not the CF/laptop bridge.

The mechanism it reuses:

**Reuse — do not rebuild (all present):**
- Sandbox clone: `mcp-server/src/workspace/source-materializer.ts` (`sandboxRoot()`,
  `cloneIntoWorkspace`, `gitFetchWithRetry`).
- Brokered short-lived, repo-scoped GitHub READ credentials:
  `context-fabric/services/context_api_service/app/git_broker.py` (already consumed by the
  materializer, held in-memory only).
- Indexer: `mcp-server/src/workspace/ast-index.ts`.

**The change:** run the materializer + indexer **eagerly at onboard** on a **central
server-side runner** (not the laptop), using brokered creds → clone into a sandbox →
build world model + AST index + embeddings centrally. Replaces the deferred Phase-2 AST
step (`capability.service.ts` bootstrap).

**Design decisions:**
- **Credentials:** prefer the broker (short-lived, repo-scoped) over a static service PAT
  baked into agent-runtime — except single-tenant / on-prem, where a static PAT in one
  trust domain is acceptable and simplest. Do not concentrate a static multi-repo key in
  one service otherwise.
- **Static vs dynamic:** static grounding (parse / index / embed — read-only over the
  clone) is safe centrally. **Dynamic** grounding (running build/test to verify commands)
  executes untrusted customer code → requires real container isolation (no host access,
  egress limits, resource caps); add only if executed-command verification is needed
  (grounding is static today).
- **Runtime location:** the sandbox MUST run on a central runner, or the laptop
  dependency remains.

**Validation status:** esbuild-verified only — there is no live central mcp-server + broker
in the build env, so the end-to-end (clone → index → callbacks) must be exercised on a
central runner before relying on it. For it to be truly "central", `MCP_SERVER_URL` must
point at a central mcp-server (not a laptop dial-in) and `MCP_AUTO_CHECKOUT_SOURCE` must be
on. **Bonus:** a central-owned clone enables scheduled/webhook re-clone + re-index, which
strengthens Workstream C (freshness) beyond the laptop model.
