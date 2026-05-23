"""
M73 — governance gating.

TODO(M73-followup): extract from execute.py:920..1849.

Targets the four governance touchpoints currently inline in execute():

  fail_closed_precheck(req, cf_call_id, trace_id) → None | HTTPException(503)
      Calls audit_gov_emit.emit_audit_event_strict to confirm audit-gov is
      reachable BEFORE the LLM call runs. If audit is down and the request
      declared governance_mode=fail_closed, refuse 503 GOVERNANCE_UNAVAILABLE
      rather than produce un-governed work.
      Currently inline at execute.py:931-979.

  degraded_mode_decision(req, context_plan_status, composer_warnings)
      Returns ("full" | "degraded" | "block", reason). When the contextPlan
      flags missing required layers and the caller is in fail_open/degraded
      mode, we drop the LLM call and run the agent with read-only tools
      only. The decision is per-stage; QA stages already have read-only
      tools so degraded mode is a no-op for them.
      Currently inline at execute.py:~1100-1230.

  human_approval_pause(req, mcp_response, audit_event)
      When governance_mode=human_approval_required and mcp returns a
      pendingApproval, persist the continuation token, emit
      governance.pause_for_approval audit event, return the call_log row
      in PAUSED status. The caller (workgraph-api) renders the approval
      gate and resumes via /execute/resume.
      Currently inline at execute.py:~1500-1620 + /execute/resume handler.

  emit_governance_events(kind, ...)
      Thin wrapper around audit_gov_emit.emit_audit_event for the
      governance.* event types: precheck_allowed, precheck_denied,
      degraded_mode_engaged, pause_for_approval, approved, denied. Today
      these are emitted from inside execute() with the same fields each
      time; centralising lets us evolve the schema once.

Why deferred: each touchpoint reads + mutates ~10 local variables in
execute()'s body (cf_call_id, trace_id, governance_mode, audit_event_id,
context_plan_status, mcp_response, …). Lifting them cleanly requires
either passing a context object or threading those vars through the new
module functions. Both reshape execute()'s control flow, which is the
work the orchestrator.py extraction will do anyway. Doing them together
is safer than half-extracting one and half the other.
"""
from __future__ import annotations
