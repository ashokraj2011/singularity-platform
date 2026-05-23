"""
M71 — Tool gateway. The hard-refuse chokepoint.

Every tool call the agent issues passes through `check_tool_allowed()` BEFORE
context-fabric dispatches it to mcp-server. If the tool isn't in the current
phase's allowlist (or is explicitly in `forbidden_tools`), we raise
`PhaseToolForbidden` and the loop returns a structured error so the LLM can
recover (typically: pick a different tool, advance the phase, or give up).

There is no soft mode. There is no warn-only. The architectural decision is
hard-refuse; observability comes from audit-gov events emitted around each
refusal, not from policy laxity.
"""
from __future__ import annotations

from dataclasses import dataclass

from .phase_state import Phase
from .policy_loader import StagePolicy


@dataclass(frozen=True)
class ToolGatewayDecision:
    """Result of a tool-permission check. `allowed=True` means dispatch."""

    allowed: bool
    tool_name: str
    phase: Phase
    reason: str = ""
    allowed_tools: tuple[str, ...] = ()


class PhaseToolForbidden(PermissionError):
    """Raised when an agent invokes a tool outside the current phase's
    allowlist. Carries the actual allowlist so the caller can surface a
    structured 400 to the LLM (and so the LLM can pick a valid tool next turn).

    The error code on the wire is PHASE_TOOL_FORBIDDEN (matches the spec's
    suggested error codes in §24).
    """

    error_code = "PHASE_TOOL_FORBIDDEN"

    def __init__(self, tool_name: str, phase: Phase, allowed_tools: tuple[str, ...], reason: str):
        super().__init__(reason)
        self.tool_name = tool_name
        self.phase = phase
        self.allowed_tools = allowed_tools
        self.reason = reason

    def to_dict(self) -> dict[str, object]:
        """Wire shape returned in the /execute response so the LLM can see
        the actual allowlist (we want the model to learn the policy, not
        guess at it)."""
        return {
            "error_code": self.error_code,
            "tool_name": self.tool_name,
            "phase": self.phase.value,
            "allowed_tools": list(self.allowed_tools),
            "reason": self.reason,
        }


def allowed_tools_for(policy: StagePolicy, phase: Phase) -> tuple[str, ...]:
    """Return the sorted allowlist for `phase`, with `forbidden_tools` removed.

    Returns an empty tuple when the phase has no row in the policy (e.g. the
    PRODUCT_OWNER intake policy has no ACT phase, so any tool is forbidden
    while in ACT — which is itself a phase the intake stage can't reach via
    `can_transition`).
    """
    phase_policy = policy.phases.get(phase)
    if phase_policy is None:
        return ()
    deny = phase_policy.forbidden_tools
    return tuple(sorted(t for t in phase_policy.allowed_tools if t not in deny))


def check_tool_allowed(
    policy: StagePolicy,
    phase: Phase,
    tool_name: str,
    *,
    raise_on_refuse: bool = True,
) -> ToolGatewayDecision:
    """Hard-refuse gateway for a single tool call.

    Behaviour:
      * Empty allowlist for the phase → refused. (Phases that legitimately
        have no tools — e.g. INTAKE PLAN — should never see a tool call in
        the first place; if one arrives we refuse it.)
      * Tool in `forbidden_tools` → refused even if it's also in
        `allowed_tools`. Deny wins on conflict, per spec §8.
      * Tool not in `allowed_tools` → refused.
      * Otherwise → allowed.

    When `raise_on_refuse` is True (default), a refusal raises
    `PhaseToolForbidden`. When False, returns a decision object — useful for
    bulk checks where the caller wants to short-circuit on the first refuse
    without exception overhead.
    """
    phase_policy = policy.phases.get(phase)
    if phase_policy is None:
        decision = ToolGatewayDecision(
            allowed=False,
            tool_name=tool_name,
            phase=phase,
            reason=f"phase {phase.value} has no policy row for stage_key={policy.stage_key} agent_role={policy.agent_role}",
            allowed_tools=(),
        )
    elif tool_name in phase_policy.forbidden_tools:
        decision = ToolGatewayDecision(
            allowed=False,
            tool_name=tool_name,
            phase=phase,
            reason=f"tool {tool_name!r} is explicitly forbidden in phase {phase.value}",
            allowed_tools=allowed_tools_for(policy, phase),
        )
    elif tool_name not in phase_policy.allowed_tools:
        decision = ToolGatewayDecision(
            allowed=False,
            tool_name=tool_name,
            phase=phase,
            reason=f"tool {tool_name!r} is not in the allowlist for phase {phase.value}",
            allowed_tools=allowed_tools_for(policy, phase),
        )
    else:
        decision = ToolGatewayDecision(
            allowed=True,
            tool_name=tool_name,
            phase=phase,
            allowed_tools=allowed_tools_for(policy, phase),
        )

    if not decision.allowed and raise_on_refuse:
        raise PhaseToolForbidden(
            tool_name=tool_name,
            phase=phase,
            allowed_tools=decision.allowed_tools,
            reason=decision.reason,
        )
    return decision
