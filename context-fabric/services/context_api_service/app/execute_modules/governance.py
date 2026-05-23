"""
M73 — governance gating.

Owns the policy decisions that sit between "request landed" and "LLM call
ran". The four touchpoints currently inline in execute():

  fail_closed_precheck(governance_mode, req, cf_call_id, trace_id) → None
      ✅ EXTRACTED below.
      Calls audit_gov_emit.emit_audit_event_strict to confirm audit-gov is
      reachable BEFORE the run starts. If audit is down and the request
      declared governance_mode=fail_closed, refuse 503 GOVERNANCE_UNAVAILABLE
      rather than produce un-governed work.

  degraded_mode_decision(req, context_plan_status, composer_warnings)
      TODO(M73-followup-2). Returns ("full" | "degraded" | "block", reason).
      When the contextPlan flags missing required layers and the caller is in
      fail_open/degraded mode, we drop the LLM call and run the agent with
      read-only tools only. The decision is per-stage; QA stages already
      have read-only tools so degraded mode is a no-op for them.
      Currently inline at execute.py:~410-480.

  human_approval_pause(req, mcp_response, audit_event)
      TODO(M73-followup-3). When governance_mode=human_approval_required and
      mcp returns a pendingApproval (or the contextPlan is missing required
      layers under human_approval_required), persist the continuation token,
      emit governance.pause_for_approval, return the response envelope in
      WAITING_APPROVAL status. The caller (workgraph-api) renders the
      approval gate and resumes via /execute/resume.
      Currently inline at execute.py:~480-585 (context-plan side) and
      ~900-1000 (mcp pendingApproval side).

  emit_governance_events(kind, ...)
      TODO(M73-followup-4). Thin wrapper around audit_gov_emit for the
      governance.* event family. Today these are emitted with the same
      fields each time; centralising lets us evolve the schema once.

The first extraction is done; the other three are blocked on orchestrator
restructuring (each reads + mutates ~10 local variables in execute()'s
body — lifting them cleanly requires either a context object or threading
those vars through, both of which reshape execute()'s control flow). That
reshaping is what the orchestrator.py extraction will do anyway.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from ..audit_gov_emit import (
    AuditGovUnavailable,
    emit_audit_event,
    emit_audit_event_strict,
)


async def fail_closed_precheck(
    governance_mode: str,
    req: Any,
    cf_call_id: str,
    trace_id: str,
) -> None:
    """Refuse to start a run if governance_mode=fail_closed and audit-gov
    is unreachable.

    The contract: callers that declare ``governance_mode=fail_closed`` are
    asking for "no untraceable work". Before we let the agent loop spend
    tokens we must confirm audit-gov can receive events. We do that by
    emitting a single ``governance.precheck.allowed`` event via the
    *strict* emitter (the regular ``emit_audit_event`` is fire-and-forget;
    this one awaits + raises). A successful emit means the audit channel
    is healthy enough that subsequent fire-and-forget emits will land.

    On failure we emit ``governance.precheck.denied`` via the
    fire-and-forget path (don't try the strict emit again — same endpoint
    that just failed) and raise HTTP 503 with a clear remediation message.
    Workgraph renders that 503 as a banner the operator can act on.

    For any other ``governance_mode`` (``fail_open`` / ``degraded`` /
    ``human_approval_required``) this is a no-op.

    Raises:
        HTTPException(503, GOVERNANCE_UNAVAILABLE): when fail-closed and
            audit-gov is down. The original AuditGovUnavailable reason is
            included in the detail body for debugging.
    """
    if governance_mode != "fail_closed":
        return

    capability_id = req.run_context.capability_id
    actor_id = req.run_context.user_id
    workflow_instance_id = req.run_context.workflow_instance_id
    workflow_node_id = req.run_context.workflow_node_id

    try:
        await emit_audit_event_strict(
            kind="governance.precheck.allowed",
            trace_id=trace_id,
            capability_id=capability_id,
            actor_id=actor_id,
            severity="info",
            payload={
                "cf_call_id": cf_call_id,
                "governance_mode": governance_mode,
                "check": "audit_gov_reachable",
                "workflow_instance_id": workflow_instance_id,
                "workflow_node_id": workflow_node_id,
            },
        )
    except AuditGovUnavailable as err:
        # The strict path just failed — the denial event has to ride the
        # fire-and-forget channel so it can land if/when audit-gov recovers.
        emit_audit_event(
            kind="governance.precheck.denied",
            trace_id=trace_id,
            capability_id=capability_id,
            actor_id=actor_id,
            severity="warn",
            payload={
                "cf_call_id": cf_call_id,
                "governance_mode": governance_mode,
                "check": "audit_gov_reachable",
                "reason": str(err),
            },
        )
        raise HTTPException(status_code=503, detail={
            "code": "GOVERNANCE_UNAVAILABLE",
            "message": (
                "governance_mode=fail_closed but audit-governance is unreachable. "
                "Refusing to run un-governed. Either retry once audit-gov is healthy, "
                "or set governance_mode=fail_open on this request."
            ),
            "reason": str(err),
            "trace_id": trace_id,
        })
