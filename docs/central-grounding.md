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

## Remaining: eager central materialization at onboard (D3 — needs a central runner)

Today the code half of grounding (the AST index) is built **lazily on the runtime**
(often the laptop) on the first workflow run. To make it central and eager:

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

**Why it's not implemented here:** it is a cross-service orchestration change
(agent-runtime bootstrap → central runner → materializer/indexer) that needs a live
central runner + brokered-credential wiring to build and validate. It is documented here
rather than shipped blind. **Bonus once built:** a central-owned clone enables
scheduled/webhook re-clone + re-index, which strengthens Workstream C (freshness) beyond
the laptop model.
