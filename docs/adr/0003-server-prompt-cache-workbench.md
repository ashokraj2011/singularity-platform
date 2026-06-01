# ADR 0003: Server-level prompt caching for workbench LLM calls

## Status

Proposed.

## Context

Every workbench LLM call (coding stages, `AGENT_TASK` nodes, the governed
turn loop) routes through one path:

```
workbench / workflow runtime
  → context-fabric governed loop (context_api_service/app/governed/)
  → mcp-server  (mcp-server/src/llm/client.ts → callGateway)
  → llm-gateway (context-fabric/services/llm_gateway_service)
  → provider    (Anthropic Messages API / OpenAI-compatible)
```

The expensive step we want to avoid re-paying is the **prefill / prompt
pre-fill** — the attention pass over the input tokens before the first
output token. For a workbench coding turn the input is dominated by a
large, *stable* prefix that repeats turn after turn:

1. the stage **system prompt** (assembled by prompt-composer),
2. the **tool descriptors** (the MCP tool catalog for the stage),
3. the **capability / repo context** package,
4. the growing **conversation history** (stable up to the latest turn).

Only the tail (the newest user/tool messages) changes between turns. With
Anthropic prompt caching, the stable prefix is pre-filled once and the
cached KV blocks are reused on subsequent calls within the cache TTL —
turning the most expensive step into a cache read for ~90% of the input.

### What exists today

The `prompt_cache` concept is **plumbed but dead end-to-end**:

- `mcp-server/src/llm/types.ts:16-20` defines `PromptCacheRequest`
  (`{ enabled?, strategy?: "provider_auto" | "anthropic_cache_control" |
  "copilot_gateway", key? }`) and threads it through `LlmRequest`.
- `mcp-server/src/llm/client.ts:258` forwards `prompt_cache` to the gateway
  **only when `req.prompt_cache.enabled` is true**, and
  `normalizePromptCacheUsage` (`:64-67, :276`) is ready to read cache usage
  back from the response.
- **No caller ever sets `prompt_cache.enabled`.** Grep across mcp-server,
  context-fabric, and workgraph-studio finds zero call sites that construct
  a `prompt_cache` with `enabled: true`. The governed loop
  (`context_api_service/app/governed/`) passes none.
- The gateway request model `ChatCompletionRequest`
  (`llm_gateway_service/app/types.py:49-70`) has **no `prompt_cache` field**
  and does not set `extra="allow"`, so even if a caller sent it, Pydantic
  **silently drops it** at the gateway boundary.
- The Anthropic provider (`llm_gateway_service/app/providers/anthropic.py`)
  builds `system` (`:137, :165-166`) and `tools` (`:141-147, :169-171`) as
  plain strings/objects and **never emits `cache_control`**. The only
  cache-related code (`:295-297`) *reads* `cache_creation_input_tokens` from
  the response usage — it never *requests* caching.

So today every workbench turn re-pays full prefill on the entire stable
prefix. The wiring to fix it is half-present but inert.

### Constraints that shape the design

- **MCP-only egress (ADR-aligned).** Providers are reachable only from
  llm-gateway; mcp-server and everything upstream talk to the gateway over
  `LLM_GATEWAY_URL`. Cache injection therefore belongs in the gateway's
  provider adapter, not in callers.
- **Prefix stability is a *correctness* precondition, not a nicety.** A
  cache hit requires a **byte-identical prefix** up to the cache breakpoint.
  Any per-turn nondeterminism in the system prompt, tool ordering, or
  context package (timestamps, hash maps with unstable iteration order,
  re-sorted tool lists) silently drops the hit rate to ~0 while still
  paying the 25% cache-write surcharge — strictly worse than no caching.
- **Provider asymmetry.** Anthropic uses explicit `cache_control`
  breakpoints (max 4) + a beta header and bills cache writes/reads
  distinctly. OpenAI-compatible endpoints cache automatically by prefix
  (no breakpoints to set) but only above a token threshold and only with
  prefix stability. A self-hosted/vLLM-style engine caches by KV/prefix and
  additionally needs **request affinity** (the follow-up turn must land on
  the same replica that holds the KV blocks).
- **Copilot path.** The office Copilot-only mode routes through the
  gateway-as-Copilot strategy; cache semantics there are the gateway's, not
  Anthropic's. The `"copilot_gateway"` strategy enum already anticipates
  this.

## Decision (proposed)

Make server-level prompt caching the **default** for workbench LLM calls,
implemented at the gateway and enabled by callers, with prefix stability
treated as a hard contract. Four parts:

### 1. Gateway honors and injects cache directives (the load-bearing change)

- Add an optional `prompt_cache` field to `ChatCompletionRequest`
  (`llm_gateway_service/app/types.py`) so it survives the hop. (Do **not**
  switch the model to `extra="allow"` — add the explicit field; silent
  passthrough of unknown fields is its own footgun.)
- In `providers/anthropic.py respond()`, when `prompt_cache.enabled` and the
  strategy is `provider_auto`/`anthropic_cache_control`:
  - send the beta header `anthropic-beta: prompt-caching-2024-07-31`
    (pin via `settings`, like `anthropic_version`);
  - place **`cache_control: {type: "ephemeral"}` breakpoints** on the
    longest stable prefixes, in cache order:
    1. last block of the **`tools`** array,
    2. last block of the **`system`** prompt (convert `system` to the
       block-array form to attach `cache_control`),
    3. optionally the last block of the **stable conversation prefix**
       (the message before the newest user/tool turn).
    Cap at the 4-breakpoint Anthropic limit; never put a breakpoint on the
    volatile tail.
  - read back `cache_creation_input_tokens` / `cache_read_input_tokens` and
    surface them in `ChatCompletionResponse` (the plumbing at
    `mcp-server/src/llm/client.ts:64-67` already expects this).
- For the OpenAI-compatible adapter: caching is automatic; the gateway's
  job is only to **preserve prefix order** and expose any
  `cached_tokens`-style usage it returns. No breakpoint injection.

### 2. Callers default workbench requests to `prompt_cache.enabled`

- The governed loop (`context_api_service/app/governed/`) and the
  mcp-server workbench request builders set
  `prompt_cache = { enabled: true, strategy: "provider_auto" }` by default
  for interactive/workbench turns, behind a config flag
  (e.g. `LLM_PROMPT_CACHE_ENABLED`, default on) so it can be killed fast if
  a provider misbehaves.
- One-shot/throwaway calls (no repeated prefix) may leave it off to avoid
  the cache-write surcharge with no offsetting read.

### 3. Prefix stability contract (enforced, not hoped-for)

The cache only pays off if the prefix is byte-stable. We make that a
checked invariant:

- **prompt-composer** must emit the stable segments (system, tool catalog,
  capability/repo context) deterministically: fixed tool ordering, sorted
  keys, **no per-call timestamps / nonces / unstable map iteration** inside
  the cached prefix. Volatile data (current time, turn counter) goes in the
  **tail**, after the last breakpoint.
- Add a lightweight **cache-key / prefix-hash** debug field: hash the
  intended-stable prefix and log it per turn. A stable session should show
  the same hash turn-over-turn; a changing hash is the canary that
  something non-deterministic crept into the prefix.
- Optionally pass an explicit `prompt_cache.key` (already in the type) to
  scope/segment caches per session+stage for observability.

### 4. Routing affinity for self-hosted engines (only if/when used)

For Anthropic/OpenAI SaaS, the provider owns cache locality — nothing to
do. **If** a self-hosted/vLLM-class provider is ever added behind the
gateway, the gateway's provider selection must route a session's follow-up
turns to the **same upstream replica** (consistent hashing on
session/stage key) so the KV/prefix cache is actually present. Captured
here so the requirement isn't rediscovered later; out of scope until such a
provider exists.

## Consequences

**Positive**
- Prefill on the large stable prefix is paid ~once per cache TTL instead of
  every turn — the dominant input cost of a multi-turn workbench session
  drops substantially (typically the bulk of input tokens become cache
  reads), with lower latency to first token.
- Cache-usage telemetry (`cache_read` / `cache_creation` tokens) becomes
  visible in run insights, so hit rate is measurable rather than assumed.
- The fix is centralized in the gateway, consistent with MCP-only egress.

**Negative / risks**
- **Surcharge-without-benefit trap.** Cache writes cost ~25% more; if the
  prefix isn't stable, we pay more for ~0 hits. Mitigated by the §3
  stability contract + prefix-hash canary + the kill switch.
- Anthropic's 4-breakpoint limit and minimum-cacheable-length mean very
  short prompts won't benefit; the gateway should no-op caching below the
  threshold rather than waste a breakpoint.
- Converting `system` to block form and reordering must not perturb the
  bytes for the non-cached path (avoid accidentally changing existing
  prefixes and breaking other callers' implicit OpenAI prefix caching).

**Verification plan (when implemented)**
- Gateway unit test: a request with `prompt_cache.enabled` produces an
  Anthropic body with the beta header and `cache_control` on the expected
  blocks; without it, the body is byte-identical to today (no regression).
- Integration: two consecutive identical-prefix workbench turns →
  second turn reports `cache_read_input_tokens > 0` and lower latency.
- Canary: prefix-hash is identical across turns of one stable session.

## Open questions

1. Default TTL / breakpoint set — start with system+tools (2 breakpoints)
   only, or include the conversation-prefix breakpoint from day one?
2. Should the kill switch be global (`LLM_PROMPT_CACHE_ENABLED`) or also
   per-capability (some tenants may be on providers without caching)?
3. Do we want cache-hit-rate as a first-class run-insights metric now, or
   piggyback on the existing token-usage panel?
4. Copilot-gateway strategy: confirm whether the Copilot path exposes any
   cache-read usage we can surface, or whether it's opaque.
