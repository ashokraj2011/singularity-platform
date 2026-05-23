"""
M71 Slice C(a) — Governance oracle.

The orchestrator that takes (current phase state, agent output) and returns
(next phase state, dispatched tool results, audit events). It does NOT
drive the LLM itself — that's Slice C(b)'s wrapper. This module is the
trustworthy core: pure orchestration over the phase machine, policy
loader, tool gateway, validators, and dispatch client.

Why split it this way: the oracle is testable without a real LLM. Anyone
building a new agent runtime against Singularity can call this and trust
that policy is enforced — without having to integrate llm-gateway too.

Typical call flow from workgraph-api (today) or the LLM wrapper
(Slice C(b)):

    state = PhaseState.from_dict(session.metadata.phase_state)
    result = await governed_step(
        state=state,
        agent_output={"phase_complete": True, "payload": {...}},
        tool_calls=[{"tool_name": "apply_patch", "args": {...}}],
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        run_context={...},
    )
    session.metadata.phase_state = result.next_state.to_dict()

The result carries every decision (phase advance, tool refusals, tool
results, validation errors) so the caller can render the right thing
to the operator and/or feed back into the LLM for the next turn.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from typing import Any

from .audit_emit import emit_governed_event
from .dispatch import ToolDispatchError, ToolDispatchResult, dispatch_tool
from .phase_state import Phase, PhaseState, advance_phase
from .policy_loader import PolicyNotFoundError, StagePolicy, load_stage_policy
from .tool_gateway import PhaseToolForbidden, check_tool_allowed
from .validators import PhaseOutputInvalid, validate_phase_output

log = logging.getLogger(__name__)


@dataclass
class ToolCallOutcome:
    """One element of `GovernedStepResult.tool_outcomes`. Each entry tells
    the caller (a) was this call refused on policy grounds, (b) if dispatched,
    did the underlying tool succeed."""

    tool_name: str
    phase: str
    allowed: bool
    # M73-followup #4 — keep the args the LLM emitted on this call. Used by
    # stage_driver._history_from_turn to re-construct the assistant message
    # with FULL tool_calls (id + name + arguments). Without this, when a
    # stage pauses for human approval and later resumes, the LLM is restarted
    # from persisted history with empty arguments on prior tool calls — at
    # which point "the LLM has them in its memory" is false by construction.
    # Cost is one JSON-serializable dict per call; correctness is unbounded.
    args: dict[str, Any] = field(default_factory=dict)
    refusal_reason: str | None = None
    allowed_tools: list[str] = field(default_factory=list)
    result: Any = None
    duration_ms: int = 0
    tool_invocation_id: str | None = None
    tool_success: bool | None = None
    tool_error: str | None = None
    dispatch_error: str | None = None


@dataclass
class GovernedStepResult:
    """Everything that happened this turn. Caller persists `next_state` and
    relays `tool_outcomes` / `phase_advance` / `validation_error` to the LLM
    or the operator UI as appropriate."""

    next_state: PhaseState
    # If a phase_output was supplied and validated, the parsed receipt lives
    # here. None when the turn only fired tool calls without finishing a phase.
    receipt: dict[str, Any] | None = None
    # The phase BEFORE this step, for audit + UI animations.
    from_phase: str = ""
    # The phase AFTER this step. Equal to from_phase when nothing advanced.
    to_phase: str = ""
    phase_advanced: bool = False
    # Outcomes per tool call, in dispatch order. Empty when no tool calls.
    tool_outcomes: list[ToolCallOutcome] = field(default_factory=list)
    # When validation failed, the raw validator details bubble up here so
    # the LLM wrapper (Slice C(b)) can format them as a tool-result message
    # for the next turn.
    validation_error: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "next_state": self.next_state.to_dict(),
            "receipt": self.receipt,
            "from_phase": self.from_phase,
            "to_phase": self.to_phase,
            "phase_advanced": self.phase_advanced,
            "tool_outcomes": [asdict(o) for o in self.tool_outcomes],
            "validation_error": self.validation_error,
        }


def _normalize_tool_call(raw: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Accept either `{tool_name, args}` or LLM-style `{name, arguments}`.

    LLM tool-call shapes vary by provider; this helper normalises into the
    shape `dispatch_tool` expects. Unknown shapes raise ValueError so the
    caller's bug is loud rather than silent.
    """
    name = raw.get("tool_name") or raw.get("name")
    if not name or not isinstance(name, str):
        raise ValueError(f"tool call missing tool_name/name: {raw!r}")
    args = raw.get("args")
    if args is None:
        args = raw.get("arguments", {})
    if not isinstance(args, dict):
        raise ValueError(f"tool call args must be an object: {raw!r}")
    return name, args


async def governed_step(
    *,
    state: PhaseState,
    stage_key: str,
    agent_role: str | None,
    tool_calls: list[dict[str, Any]] | None = None,
    phase_output: dict[str, Any] | None = None,
    next_phase: Phase | None = None,
    run_context: dict[str, Any] | None = None,
    bearer: str | None = None,
    policy: StagePolicy | None = None,
) -> GovernedStepResult:
    """Run one governed turn.

    Order of operations:

      1. Load StagePolicy if not provided (cached by policy_loader).
      2. If tool_calls present:
           For each: check_tool_allowed() → if refused, capture refusal
           with allowlist (the LLM can pick a valid tool next turn);
           if allowed, dispatch via /mcp/tool-run and capture the result.
      3. If phase_output present:
           validate_phase_output() → raises PhaseOutputInvalid on shape
           failures. We catch + put it on `validation_error` so the caller
           can choose to retry the same phase rather than abort.
      4. If phase_output validated AND next_phase declared:
           advance_phase() — appends the receipt, bumps repair_attempts
           where applicable, sets approval_pending on SELF_REVIEW.
      5. Emit a `governed.step` audit-gov event with the full outcome.

    Refused tool calls do NOT block the turn. The LLM wrapper (Slice C(b))
    is responsible for feeding the refusal back to the model so it can
    retry with an allowed tool. This is the "self-correct" path baked into
    the spec's PHASE_TOOL_FORBIDDEN error.

    Validation failures DO block phase advancement. They don't advance the
    machine; the caller is expected to surface the structured details to
    the LLM so it can fix the receipt and retry the same phase.
    """
    tool_calls = tool_calls or []
    if policy is None:
        try:
            policy = await load_stage_policy(stage_key, agent_role, bearer=bearer)
        except PolicyNotFoundError:
            # No policy means we have no allowlist. Hard refuse everything;
            # the caller must seed a policy before calling this stage.
            raise

    result = GovernedStepResult(
        next_state=state,
        from_phase=state.current_phase.value,
        to_phase=state.current_phase.value,
    )

    # ── 1. Tool dispatch with hard-refuse policy ──────────────────────────

    for raw in tool_calls:
        try:
            tool_name, args = _normalize_tool_call(raw)
        except ValueError as exc:
            log.warning("malformed tool call payload: %s", exc)
            # Best-effort args grab for malformed calls — the LLM still
            # needs to see something in the round-tripped history. If
            # the payload is genuinely garbled, default-factory {} is fine.
            raw_args = raw.get("args") or raw.get("arguments") or {}
            if not isinstance(raw_args, dict):
                raw_args = {}
            result.tool_outcomes.append(
                ToolCallOutcome(
                    tool_name=str(raw.get("name") or raw.get("tool_name") or "<unknown>"),
                    phase=state.current_phase.value,
                    allowed=False,
                    args=raw_args,
                    refusal_reason=f"malformed tool call: {exc}",
                )
            )
            continue

        try:
            check_tool_allowed(policy, state.current_phase, tool_name)
        except PhaseToolForbidden as refusal:
            log.info(
                "tool refused tool=%s phase=%s policy=%s",
                tool_name,
                state.current_phase.value,
                policy.policy_id,
            )
            result.tool_outcomes.append(
                ToolCallOutcome(
                    tool_name=tool_name,
                    phase=state.current_phase.value,
                    allowed=False,
                    args=args,
                    refusal_reason=refusal.reason,
                    allowed_tools=list(refusal.allowed_tools),
                )
            )
            await emit_governed_event(
                kind="governed.tool_refused",
                state=state,
                policy=policy,
                run_context=run_context,
                payload={
                    "tool_name": tool_name,
                    "reason": refusal.reason,
                    "allowed_tools": list(refusal.allowed_tools),
                },
                severity="warn",
            )
            continue

        # Allowed → dispatch to mcp-server's /mcp/tool-run.
        try:
            outcome = await dispatch_tool(
                tool_name=tool_name,
                args=args,
                work_item_id=(run_context or {}).get("work_item_id")
                or (run_context or {}).get("workItemId"),
                workspace_id=(run_context or {}).get("workspace_id")
                or (run_context or {}).get("workspaceId"),
                run_context=run_context,
                bearer=bearer,
            )
            result.tool_outcomes.append(
                ToolCallOutcome(
                    tool_name=tool_name,
                    phase=state.current_phase.value,
                    allowed=True,
                    args=args,
                    result=outcome.result,
                    duration_ms=outcome.duration_ms,
                    tool_invocation_id=outcome.tool_invocation_id,
                    tool_success=outcome.tool_success,
                    tool_error=outcome.tool_error,
                )
            )
            await emit_governed_event(
                kind="governed.tool_dispatched",
                state=state,
                policy=policy,
                run_context=run_context,
                payload={
                    "tool_name": tool_name,
                    "tool_invocation_id": outcome.tool_invocation_id,
                    "duration_ms": outcome.duration_ms,
                    "tool_success": outcome.tool_success,
                },
            )
        except ToolDispatchError as exc:
            log.warning("tool dispatch failed tool=%s err=%s", tool_name, exc)
            result.tool_outcomes.append(
                ToolCallOutcome(
                    tool_name=tool_name,
                    phase=state.current_phase.value,
                    allowed=True,
                    args=args,
                    dispatch_error=str(exc),
                )
            )
            await emit_governed_event(
                kind="governed.tool_dispatch_failed",
                state=state,
                policy=policy,
                run_context=run_context,
                payload={"tool_name": tool_name, "error": str(exc)},
                severity="warn",
            )

    # ── 2. Phase output validation + advance ──────────────────────────────

    if phase_output is not None:
        try:
            receipt = validate_phase_output(state.current_phase, phase_output, policy=policy)
        except PhaseOutputInvalid as exc:
            log.info(
                "phase output invalid phase=%s details=%d",
                state.current_phase.value,
                len(exc.details),
            )
            result.validation_error = exc.to_dict()
            await emit_governed_event(
                kind="governed.phase_output_invalid",
                state=state,
                policy=policy,
                run_context=run_context,
                payload=exc.to_dict(),
                severity="warn",
            )
            return result

        result.receipt = receipt

        if next_phase is not None:
            try:
                new_state = advance_phase(
                    state,
                    next_phase,
                    receipt=receipt,
                    max_repair_attempts=policy.max_repair_attempts,
                    max_plan_rewinds=policy.max_plan_rewinds,
                )
            except ValueError as exc:
                # Illegal transition or repair cap exceeded. Don't advance;
                # surface to caller so they can branch (BLOCKED stage, etc.).
                result.validation_error = {
                    "error_code": "PHASE_TRANSITION_REFUSED",
                    "phase": state.current_phase.value,
                    "reason": str(exc),
                }
                await emit_governed_event(
                    kind="governed.phase_transition_refused",
                    state=state,
                    policy=policy,
                    run_context=run_context,
                    payload={"reason": str(exc), "attempted_next": next_phase.value},
                    severity="warn",
                )
                return result

            result.next_state = new_state
            result.to_phase = new_state.current_phase.value
            result.phase_advanced = new_state.current_phase is not state.current_phase
            await emit_governed_event(
                kind="governed.phase_completed",
                state=state,
                policy=policy,
                run_context=run_context,
                payload={
                    "from_phase": state.current_phase.value,
                    "to_phase": new_state.current_phase.value,
                    "receipt_kind": receipt.get("kind"),
                    "approval_pending": new_state.approval_pending,
                },
            )

    return result
