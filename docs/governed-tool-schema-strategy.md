# Tool schema strategy for the governed loop

**Status**: Design only. Task #120. Implementation gated on capability-harness baseline.

## The trade-off we made (M72 Slice A)

`context-fabric/services/context_api_service/app/governed/turn.py:166`
emits a generic schema for every real tool:

```python
descriptors.append({
    "name": tool_name,
    "description": (
        f"MCP tool '{tool_name}'. Phase scope: {', '.join(scopes)}. "
        f"Calling it outside its scope returns PHASE_TOOL_FORBIDDEN; "
        f"choose a tool whose scope includes the current phase."
    ),
    "input_schema": {"type": "object"},
})
```

The only tool with a real schema is the synthetic `submit_phase_output`
(line 178).

The reason: Anthropic / OpenAI / Gemini all hash the tool list when
deciding cache eligibility. Including per-phase schemas in
`input_schema` would invalidate the cache on every phase transition,
which over a 25-turn stage with ~4 phases = ~$0.50–$1.00 in
unnecessary prompt-token charges per stage at production rates.

The reviewer is right that this costs tool-call reliability — an LLM
asked to call `apply_patch` without seeing its arg shape has to guess
at `{patch: "..."}` vs `{file, content}` vs `{diff, target_file}` from
the description string alone. Models that get it wrong burn turns on
PHASE_TOOL_FORBIDDEN refusals + retries.

## What we DON'T have data on

- How often the wrong-shape problem actually fires in production.
- How much faster a stage completes when the LLM gets schemas.
- Whether the cache hit is preserved at all in production (some
  providers re-validate the cache on every request anyway).

The capability harness (M74 Phase 4, shipped this session) is what
gives us this data. **No implementation work on tool schemas should
ship before we have a baseline run.**

## Options when we have the baseline

Listed from least-invasive to most:

### Option A — Schema-in-description string

Put a JSON-schema fragment in the description string itself:

```python
"description": (
    f"MCP tool '{tool_name}'. Schema: {json.dumps(tool_schema)}. "
    f"Phase scope: {', '.join(scopes)}."
),
```

Cache stability: ✅ preserved (description is still a constant).
Reliability: ⚠️ depends on the model — Claude/GPT-4 read it, smaller
models often ignore it.

Effort: ~half day. Zero risk to cache.

### Option B — Per-tool input_schema, accept cache invalidation

Just emit real schemas. Measure the cost impact on the harness; if
the reliability gain outweighs the prompt-token spend, ship it.

Cache stability: ❌ broken across phase transitions.
Reliability: ✅ best.

Effort: ~1 day + cost monitoring runbook. Requires every tool in
mcp-server's registry to ship a JSON schema (some don't today).

### Option C — Tier the cache by phase

Keep the *same* schemas across an entire stage so the cache stays
warm within the stage but invalidates between stages. Per-stage
caching is the granularity prompt-providers actually charge against
anyway.

Implementation: build the union of all phase schemas at stage start,
emit them all every turn. Tool gateway already does the union for
the descriptor list — extending to schemas is mechanical.

Cache stability: ✅ within a stage (which is what matters for prompt
caching at ~5min TTL).
Reliability: ✅ same as Option B.

Effort: ~1-2 days.

**Recommended path when we have data**: Option C, if the harness
shows reliability is a real bottleneck. Otherwise leave as-is.

## Decision matrix

| Capability-harness shows... | Action |
|---|---|
| `<5%` of dispatch errors come from wrong-shape calls | Leave as-is. The cost isn't worth the risk. |
| `5%–15%` of errors from wrong-shape calls | Ship Option A. Cheapest fix; preserves cache. |
| `>15%` of errors from wrong-shape calls | Ship Option C. Reliability matters more than cache stability at this rate. |
| Wrong-shape errors only on a specific tool family (e.g. patch tools) | Ship Option B *for that family only*; leave others on the generic schema. |

## How to measure

1. Run the capability harness for 2 weeks against the production
   model fleet (Phase 4B weekly cron handles this once configured).
2. Filter audit-gov for `governed.tool_dispatched` events where
   `tool_success: false` AND the failure pattern matches
   "wrong-shape" (regex on `tool_error` for "missing required",
   "unexpected field", etc.).
3. Group by `tool_name` and divide by total dispatches to get the
   wrong-shape rate per tool.
4. Match against the decision matrix.

A useful audit-gov saved query:

```json
{
  "kinds": ["governed.tool_dispatched"],
  "since": "2026-05-25T00:00:00Z"
}
```

Then post-process the JSONL to extract the rate.

## Why not just ship Option C now

Because we don't have a real number for the reliability cost. The
M72 Slice A team chose cache stability after evidence that prompt
caching reduced per-stage spend by 30-40%. Re-introducing
schema-per-tool without measuring the reliability gain risks
spending that money for nothing.

The capability harness is the right gate. Its first baseline run
plus 2 weeks of trailing data is enough to make a defensible call.
A premature ship of any of these options based on intuition could
either:

- **Break the prompt-cache contract**, materially increasing the
  per-stage cost without a measurable reliability gain.
- **Leave reliability on the table** by picking Option A when
  Option C would have moved the needle.

## Tracking

- **Task #120** — this strategy doc.
- **Task #84** — eval harness; this is the data source.
- **Task #114-117** — capability harness; ships the measurement infra.
- Implementation task to be created when the baseline data is in
  hand.
