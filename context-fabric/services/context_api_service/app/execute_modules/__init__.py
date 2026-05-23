"""
M73 — execute.py refactor target modules.

context-fabric's `app/execute.py` grew to 2557 lines as the agent loop's
swiss-army-knife: HTTP helpers, stage classification, tool inventory,
runtime resolution, prompt compilation, governance gating, conversation
memory, MCP dispatch, laptop bridge routing, event collection, response
shaping, and the orchestrator itself. Hard to reason about; harder to
test in isolation.

This package decomposes it into eleven focused modules:

  stage_policy.py     — classify dev/QA/story/research; allowed-operations
                        decisions for a given ExecuteRequest.
  tool_policy.py      — discover, normalise, merge mandatory local tools;
                        enforce mutation/verification/read-only contracts.
  runtime_resolver.py — per-capability MCP runtime lookup with default
                        fallback; bearer/base URL plumbing.
  prompt_context.py   — compose payload assembly, codeContextPackage +
                        worldModel attachment, contextPlan validation.
  governance.py       — fail_closed precheck, degraded-mode handling,
                        human-approval pause, audit-event emission.
  memory_context.py   — compile conversation context, persist user/
                        assistant turns, update summaries.
  mcp_dispatcher.py   — invoke the shared Agent Execution Runtime; pass
                        provider errors through verbatim.
  laptop_dispatcher.py— route through the laptop bridge; handle
                        MCP_NOT_CONNECTED / timeout fallbacks.
  event_collector.py  — live WS subscription; final HTTP drain; SSE
                        stream wiring for the /events endpoints.
  response_mapper.py  — usage metadata; final execute response; failure
                        response shape.
  orchestrator.py     — the main linear flow only.

Tier 1 (this commit) extracts the six pure-function modules: stage_policy,
tool_policy, runtime_resolver, prompt_context, response_mapper, and
event_collector. They're carved out with zero behaviour change — execute.py
imports from here instead of holding inline definitions.

Tier 2 (follow-up commits) extracts governance, memory_context,
mcp_dispatcher, laptop_dispatcher, and orchestrator. Those require pulling
chunks out of execute()'s 930-line body; deferring keeps each commit
reviewable.
"""
