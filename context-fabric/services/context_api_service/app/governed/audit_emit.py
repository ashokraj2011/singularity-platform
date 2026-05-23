"""
M71 Slice C(a) — Audit-gov emission for governed-loop events.

Thin wrapper over the existing fire-and-forget `audit_gov_emit.emit_audit_event`.
Adds the phase-machine context (current_phase, repair_attempts, policy_id,
stage_key, agent_role) to every event automatically so the operator's audit
view doesn't have to reconstruct it.

Event taxonomy (matches the M71 plan's Slice H — audit-gov ingests these
without schema changes; new event KINDS appear via the existing JSON payload):

  governed.tool_refused             — PhaseToolForbidden hit
  governed.tool_dispatched          — successful /mcp/tool-run
  governed.tool_dispatch_failed     — network / 5xx talking to mcp-server
  governed.phase_output_invalid     — receipt schema violated
  governed.phase_transition_refused — advance_phase() rejected
  governed.phase_completed          — receipt validated + state advanced
  governed.step.started             — caller invoked governed_step
  governed.step.completed           — governed_step returned (any outcome)
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..audit_gov_emit import emit_audit_event
from .phase_state import PhaseState
from .policy_loader import StagePolicy

log = logging.getLogger(__name__)


async def emit_governed_event(
    *,
    kind: str,
    state: PhaseState,
    policy: StagePolicy | None,
    run_context: dict[str, Any] | None,
    payload: dict[str, Any] | None = None,
    severity: str = "info",
) -> None:
    """Emit a governed-loop event into audit-gov.

    Always merges in the phase-machine snapshot under `payload.governance`
    so operators don't need to join multiple events to know what phase the
    agent was in when the event fired. Stays fire-and-forget — never blocks
    `governed_step`.

    Why `async`: even though the underlying emit is fire-and-forget,
    keeping this `async` lets us swap to the strict variant later without
    changing call sites.
    """
    rc = run_context or {}
    enriched: dict[str, Any] = dict(payload or {})
    enriched["governance"] = {
        "stage_key": state.stage_key,
        "agent_role": state.agent_role,
        "current_phase": state.current_phase.value,
        "repair_attempts": state.repair_attempts,
        "approval_pending": state.approval_pending,
        "policy_id": policy.policy_id if policy else None,
        "policy_version": policy.version if policy else None,
    }

    try:
        emit_audit_event(
            kind=kind,
            source_service="context-fabric",
            trace_id=rc.get("trace_id") or rc.get("traceId"),
            subject_type="blueprint_stage",
            subject_id=rc.get("workflow_node_id") or rc.get("workflowNodeId"),
            actor_id=rc.get("user_id") or rc.get("userId"),
            capability_id=rc.get("capability_id") or rc.get("capabilityId"),
            tenant_id=rc.get("tenant_id") or rc.get("tenantId"),
            severity=severity,
            payload=enriched,
        )
    except Exception as exc:
        # The downstream emitter is fire-and-forget; this catch only matters
        # if the body-building call itself raises. Keep the orchestrator alive.
        log.warning("audit emit failed kind=%s err=%s", kind, exc)

    # `await asyncio.sleep(0)` schedules the task we just created. Without it
    # a synchronous caller of governed_step (e.g. a test) might exit before
    # the fire-and-forget task runs. Cheap, deterministic.
    await asyncio.sleep(0)
