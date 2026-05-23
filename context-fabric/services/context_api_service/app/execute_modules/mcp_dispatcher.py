"""
M73 — MCP dispatch to the shared Agent Execution Runtime.

TODO(M73-followup): extract from execute.py:1380..1700.

This is the call that makes the agent loop run. The orchestrator builds
an invoke_payload (history, message, tools, system_prompt, limits, …) and
POSTs it to {mcp_base_url}/mcp/invoke. Provider errors (rate limits,
upstream 5xx, timeouts) come back with structured error codes that the
caller maps to HTTP responses for workgraph-api.

Target shape:

  dispatch_invoke(record, payload, *, timeout_sec) → InvokeResponse
      Wraps the httpx.post + error classification. Errors that map to
      LLM_GATEWAY_TIMEOUT, LLM_PROVIDER_OVERLOADED, MCP_INVOKE_FAILED
      get raised as ContextFabricInvokeError so the orchestrator can
      decide whether to surface or retry.

  dispatch_resume(record, payload) → InvokeResponse
      Same plumbing for the /mcp/resume continuation path.

The corresponding "dumb runner" path for the new governed loop lives in
mcp-server's /mcp/tool-run (Slice D) and is dispatched from
context_api_service.app.governed.dispatch.dispatch_tool — NOT through
this module. That separation is deliberate: the legacy /execute and the
new /execute-governed-stage have different error-classification
contracts and shouldn't share the dispatcher.

Note that mcp-server's POST /mcp/invoke now returns 410 after the M71
hard cutover. This dispatcher will need to be retired once all callers
move to /execute-governed-stage. Track via the open task #81.
"""
from __future__ import annotations
