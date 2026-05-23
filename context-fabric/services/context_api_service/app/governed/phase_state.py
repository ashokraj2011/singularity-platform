"""
M71 — Phase state machine for the governed coding loop.

Owns the deterministic transitions described in spec §6:

    PLAN -> EXPLORE -> ACT -> VERIFY -> SELF_REVIEW -> FINALIZE
                              |     ^
                              v     |
                             REPAIR (capped by max_repair_attempts)

The state machine is purely functional: `advance_phase()` returns a new
`PhaseState` without mutating the input, and `can_transition()` answers
yes/no without side effects. Persistence is the caller's problem
(BlueprintSession.metadata.phaseStateByStage in workgraph-api).
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class Phase(str, Enum):
    """Canonical phase enum. Matches spec §6.1 + the StagePhasePolicy.phase
    column in prompt-composer."""

    PLAN = "PLAN"
    EXPLORE = "EXPLORE"
    ACT = "ACT"
    VERIFY = "VERIFY"
    REPAIR = "REPAIR"
    SELF_REVIEW = "SELF_REVIEW"
    FINALIZE = "FINALIZE"


# Canonical forward order. Used by display code (Workbench phase strip) and
# by tests that want to walk the happy path.
PHASE_ORDER: tuple[Phase, ...] = (
    Phase.PLAN,
    Phase.EXPLORE,
    Phase.ACT,
    Phase.VERIFY,
    Phase.REPAIR,
    Phase.SELF_REVIEW,
    Phase.FINALIZE,
)


# Allowed transitions table from spec §6.3. A tuple of `(from, to)`. Anything
# not listed here is a HARD refusal regardless of policy.
#
# Why ACT -> VERIFY (only) and not ACT -> SELF_REVIEW: the spec mandates a
# verification receipt before approval, and SELF_REVIEW reads the verification
# result. Letting an agent skip VERIFY would defeat the formal-verifier gate.
#
# Why VERIFY can go to SELF_REVIEW *or* REPAIR: pass/unavailable -> review,
# fail -> repair (capped). REPAIR -> VERIFY is the retry edge.
#
# Why SELF_REVIEW -> FINALIZE: human approval happens BETWEEN these phases in
# workgraph-api (STAGE_APPROVAL is a workflow-level state, not a phase state).
_ALLOWED_TRANSITIONS: set[tuple[Phase, Phase]] = {
    (Phase.PLAN, Phase.EXPLORE),
    (Phase.PLAN, Phase.PLAN),         # re-plan on same phase if output invalid
    (Phase.EXPLORE, Phase.ACT),
    (Phase.EXPLORE, Phase.EXPLORE),
    (Phase.EXPLORE, Phase.PLAN),      # go back to plan if exploration reveals scope error
    (Phase.ACT, Phase.VERIFY),
    (Phase.ACT, Phase.ACT),
    (Phase.VERIFY, Phase.SELF_REVIEW),
    (Phase.VERIFY, Phase.REPAIR),
    (Phase.VERIFY, Phase.VERIFY),
    (Phase.REPAIR, Phase.VERIFY),
    (Phase.REPAIR, Phase.REPAIR),
    (Phase.SELF_REVIEW, Phase.FINALIZE),
    (Phase.SELF_REVIEW, Phase.REPAIR),  # human/agent: changes requested
    (Phase.SELF_REVIEW, Phase.SELF_REVIEW),
    (Phase.FINALIZE, Phase.FINALIZE),  # terminal
}


@dataclass(frozen=True)
class PhaseState:
    """The persistent state of a single stage's phase machine.

    Persisted per-stage on the session (workgraph-api stores it in
    BlueprintSession.metadata.phaseStateByStage). The dataclass is frozen so
    accidental mutation can't drift the state — all updates go through
    `advance_phase()`.
    """

    stage_key: str
    agent_role: str | None
    current_phase: Phase = Phase.PLAN
    repair_attempts: int = 0
    # Receipts collected so far, keyed by phase name. Multiple repairs append
    # new receipts each pass.
    receipts: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    # Audit trail of transitions for the Workbench phase strip + replay.
    history: list[dict[str, Any]] = field(default_factory=list)
    # Set to True once SELF_REVIEW signals recommended_for_approval=True.
    # workgraph-api opens the approval gate only when this is True.
    approval_pending: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Serialise for JSON storage in BlueprintSession.metadata."""
        return {
            "stage_key": self.stage_key,
            "agent_role": self.agent_role,
            "current_phase": self.current_phase.value,
            "repair_attempts": self.repair_attempts,
            "receipts": self.receipts,
            "history": self.history,
            "approval_pending": self.approval_pending,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PhaseState":
        """Rehydrate from JSON storage. Unknown phase strings raise ValueError."""
        return cls(
            stage_key=str(payload.get("stage_key", "")),
            agent_role=payload.get("agent_role"),
            current_phase=Phase(payload.get("current_phase", Phase.PLAN.value)),
            repair_attempts=int(payload.get("repair_attempts", 0)),
            receipts={k: list(v) for k, v in (payload.get("receipts") or {}).items()},
            history=list(payload.get("history") or []),
            approval_pending=bool(payload.get("approval_pending", False)),
        )

    @classmethod
    def fresh(cls, stage_key: str, agent_role: str | None) -> "PhaseState":
        """Construct the initial PLAN state for a new stage attempt."""
        return cls(stage_key=stage_key, agent_role=agent_role, current_phase=Phase.PLAN)


def can_transition(from_phase: Phase, to_phase: Phase) -> bool:
    """Pure predicate. No I/O. No policy lookup. Just the table."""
    return (from_phase, to_phase) in _ALLOWED_TRANSITIONS


def advance_phase(
    state: PhaseState,
    next_phase: Phase,
    *,
    receipt: dict[str, Any] | None = None,
    max_repair_attempts: int = 3,
) -> PhaseState:
    """Return a new PhaseState moved to `next_phase`.

    Rules:
      * Refuses any (current, next) pair not in `_ALLOWED_TRANSITIONS`.
      * Bumps `repair_attempts` when transitioning INTO REPAIR.
      * Refuses if `repair_attempts` would exceed `max_repair_attempts` —
        caller should treat this as a hard stage block.
      * Sets `approval_pending=True` when entering SELF_REVIEW and the receipt
        carries `recommended_for_approval=True`.
      * Appends the receipt to `state.receipts[from_phase]` (so receipts are
        bucketed by which phase PRODUCED them, not which phase received them).
      * Always appends a history entry with timestamps.

    Raises ValueError if the transition is forbidden, so the caller can
    surface a structured 400 error to the agent.
    """
    if not can_transition(state.current_phase, next_phase):
        raise ValueError(
            f"Illegal phase transition {state.current_phase.value} -> {next_phase.value}"
        )

    new_repair = state.repair_attempts + (1 if next_phase is Phase.REPAIR else 0)
    if new_repair > max_repair_attempts:
        raise ValueError(
            f"repair_attempts would exceed max_repair_attempts ({max_repair_attempts})"
        )

    receipts = {k: list(v) for k, v in state.receipts.items()}
    if receipt is not None:
        bucket = receipts.setdefault(state.current_phase.value, [])
        bucket.append(receipt)

    history = list(state.history)
    history.append(
        {
            "from": state.current_phase.value,
            "to": next_phase.value,
            "at": datetime.now(timezone.utc).isoformat(),
            "receipt_kind": receipt.get("kind") if isinstance(receipt, dict) else None,
        }
    )

    approval_pending = state.approval_pending
    if next_phase is Phase.SELF_REVIEW and isinstance(receipt, dict):
        approval_pending = bool(receipt.get("recommended_for_approval", False))

    return replace(
        state,
        current_phase=next_phase,
        repair_attempts=new_repair,
        receipts=receipts,
        history=history,
        approval_pending=approval_pending,
    )
