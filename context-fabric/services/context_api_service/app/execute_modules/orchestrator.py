"""
M73 — main linear flow for the legacy /execute path.

TODO(M73-followup): extract execute.py:920..1849.

The 930-line execute() function does the following in sequence:

  1. Mint cf_call_id, trace_id, started_at; normalise governance_mode.
     → stage_policy.governance_mode (already extracted)

  2. fail_closed precheck if governance_mode=fail_closed.
     → governance.fail_closed_precheck (TODO)

  3. Validate run_context (capability_id, tenant_id when REQUIRE_TENANT_ID).
     → orchestrator inline.

  4. Discover SERVER-target tools from tool-service, normalise them,
     union with the mandatory local inventory.
     → tool_policy.normalize_tool_for_mcp + .merge_mandatory_local_tools
       (already extracted)

  5. Resolve MCP runtime for this capability with default fallback.
     → runtime_resolver.resolve_mcp_record (already extracted)

  6. Build codeContextPackage + capability worldModel for the
     prompt-composer call.
     → prompt_context.build_code_context_package + .fetch_capability_world_model
       (already extracted)

  7. Call prompt-composer /compose-and-respond in preview mode to get the
     assembled prompt + contextPlan.
     → orchestrator inline (the call) + prompt_context.composer_context_policy

  8. Validate contextPlan; if missing required layers + governance_mode
     in {fail_closed, human_approval_required}, refuse 422.
     → prompt_context.context_plan_status + .context_plan_message + (TODO)
       governance.degraded_mode_decision

  9. Compile conversation context via context-memory /context/compile.
     → prompt_context.compile_execute_context (already extracted)

  10. Spawn the live-events WS subscriber (background asyncio task).
      → event_collector.live_subscribe (already extracted)

  11. POST {mcp_base_url}/mcp/invoke OR route through laptop_bridge.
      → mcp_dispatcher.dispatch_invoke (TODO)
      → laptop_dispatcher.dispatch_via_laptop (TODO)

  12. Stop the WS subscriber; drain residual events from mcp's HTTP ring.
      → event_collector.drain_mcp_events (already extracted)

  13. If mcp returned pendingApproval + governance_mode=human_approval_required,
      persist call_log row in PAUSED status + return early.
      → governance.human_approval_pause (TODO)

  14. Persist user + assistant turns to context-memory; maybe trigger
      summarisation.
      → memory_context.persist_turn + .maybe_summarise (TODO)

  15. Build the response envelope (usage metadata, modelUsage, …).
      → response_mapper.usage_metadata (already extracted)

  16. Persist successful call_log row; emit governance.completed audit.

So 9 of the 16 steps already have a target home (the extracted modules).
The remaining 7 are the governance + mcp_dispatcher + laptop_dispatcher
+ memory_context targets, plus the orchestration glue itself. Once all
the inline bodies are pulled out, execute() in execute.py becomes a thin
wrapper around orchestrator.run() and the file shrinks from 2557 lines
to maybe 200.

The new /execute-governed-stage path (Slice C(b) + F) already follows
this pattern in context_api_service.app.governed — the `run_stage`
function there is what `orchestrator.run` should look like once the
extraction completes.
"""
from __future__ import annotations
