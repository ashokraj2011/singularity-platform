"""
M71 — Governed coding loop enforcement module.

This package owns the deterministic phase state machine (PLAN -> EXPLORE ->
ACT -> VERIFY -> REPAIR -> SELF_REVIEW -> FINALIZE), the per-phase tool
allowlist (hard-refuse with PHASE_TOOL_FORBIDDEN), and the receipt-schema
validator. mcp-server is reduced to a dumb tool runner; ALL policy decisions
happen here.

Spec: docs/singularity_governed_coding_loop_spec.md
"""

from .phase_state import (
    PHASE_ORDER,
    Phase,
    PhaseState,
    advance_phase,
    can_transition,
)
from .policy_loader import (
    StagePolicy,
    PhasePolicy,
    PolicyNotFoundError,
    load_stage_policy,
    clear_cache as clear_policy_cache,
)
from .receipts import (
    ApprovalReceipt,
    ContextReceipt,
    EditReceipt,
    PlanReceipt,
    RepairReceipt,
    SelfReviewReceipt,
    VerificationReceipt,
    receipt_for_phase,
)
from .tool_gateway import (
    ToolGatewayDecision,
    PhaseToolForbidden,
    check_tool_allowed,
    allowed_tools_for,
)
from .validators import (
    PhaseOutputInvalid,
    validate_phase_output,
)

__all__ = [
    # phase_state
    "PHASE_ORDER",
    "Phase",
    "PhaseState",
    "advance_phase",
    "can_transition",
    # policy_loader
    "StagePolicy",
    "PhasePolicy",
    "PolicyNotFoundError",
    "load_stage_policy",
    "clear_policy_cache",
    # receipts
    "ApprovalReceipt",
    "ContextReceipt",
    "EditReceipt",
    "PlanReceipt",
    "RepairReceipt",
    "SelfReviewReceipt",
    "VerificationReceipt",
    "receipt_for_phase",
    # tool_gateway
    "ToolGatewayDecision",
    "PhaseToolForbidden",
    "check_tool_allowed",
    "allowed_tools_for",
    # validators
    "PhaseOutputInvalid",
    "validate_phase_output",
]
