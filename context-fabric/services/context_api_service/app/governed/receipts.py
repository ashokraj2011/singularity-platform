"""
M71 — Pydantic models for the structured receipts described in spec §17.

The receipt schema is what gates phase advancement: `validators.validate_phase_output()`
parses the agent's phase output into one of these models, and a ValidationError
becomes a `PHASE_OUTPUT_INVALID` 400 back to the agent. Receipt instances are
then persisted on PhaseState.receipts and emitted to audit-gov.

The shapes follow spec §17 verbatim. Optional fields stay optional so prompt
revisions can drop bits without breaking the validator — anything mandatory is
modelled as `Field(...)`.
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .phase_state import Phase


class ReceiptKind(str, Enum):
    """Discriminator for storage. One per phase + the approval receipt."""

    PLAN = "plan_receipt"
    CONTEXT = "context_receipt"
    EDIT = "edit_receipt"
    VERIFICATION = "verification_receipt"
    REPAIR = "repair_receipt"
    SELF_REVIEW = "self_review_receipt"
    APPROVAL = "approval_receipt"


class _ReceiptBase(BaseModel):
    """Common fields across every receipt. The agent supplies `payload`; the
    validator stamps `created_at` + `kind`.

    `extra="allow"` lets stage-specific overlays add project fields (e.g. a
    capability that wants `mitigation_for_regression_risk` on every PLAN
    receipt). Required-field enforcement for those extras lives in
    StagePolicy.requiredOutputSchema and is checked by `validators.py` on
    top of the Pydantic shape. Sub-models that should stay strict (e.g.
    `EditEntry.edit_type` enum) handle their own validation.
    """

    model_config = ConfigDict(extra="allow")

    kind: ReceiptKind
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── PLAN ────────────────────────────────────────────────────────────────────


class TestStrategy(BaseModel):
    model_config = ConfigDict(extra="allow")
    commands: list[str] = Field(..., min_length=1)
    reason: str | None = None


class PlanReceipt(_ReceiptBase):
    """Spec §7.1 plan output."""

    kind: Literal[ReceiptKind.PLAN] = ReceiptKind.PLAN
    target_files: list[str] = Field(..., description="Files the agent expects to touch.")
    expected_edits: list[dict[str, Any]] = Field(default_factory=list)
    symbols_to_inspect: list[str] = Field(default_factory=list)
    test_strategy: TestStrategy
    risk_level: Literal["low", "medium", "high"] = "low"
    external_side_effects_required: bool = False
    assumptions: list[str] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)


# ─── CONTEXT (EXPLORE phase) ─────────────────────────────────────────────────


class ContextItem(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["repo_map", "symbol", "ast_slice", "dependency_slice", "file"]
    target: str
    reason: str
    token_estimate: int = 0


class ContextReceipt(_ReceiptBase):
    """Spec §7.2 explore output."""

    kind: Literal[ReceiptKind.CONTEXT] = ReceiptKind.CONTEXT
    context_used: list[ContextItem] = Field(default_factory=list)
    implementation_findings: list[str] = Field(default_factory=list)
    updated_target_files: list[str] = Field(default_factory=list)
    updated_test_strategy: dict[str, Any] | None = None


# ─── EDIT (ACT phase) ────────────────────────────────────────────────────────


class EditEntry(BaseModel):
    model_config = ConfigDict(extra="allow")
    file: str
    edit_type: Literal["apply_patch", "replace_text", "replace_range", "create_file", "write_file"]
    reason: str
    anchor_hash: str | None = None
    before_summary: str | None = None
    after_summary: str | None = None


class EditReceipt(_ReceiptBase):
    """Spec §7.3 act output."""

    kind: Literal[ReceiptKind.EDIT] = ReceiptKind.EDIT
    edits: list[EditEntry] = Field(..., min_length=1)


# ─── VERIFICATION (VERIFY phase) ─────────────────────────────────────────────


class CommandResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    command: str
    exit_code: int = 0
    duration_ms: int = 0
    stdout_summary: str = ""
    stderr_summary: str = ""


class CoverageMap(BaseModel):
    model_config = ConfigDict(extra="allow")
    targeted_tests: bool = False
    full_tests: bool = False
    lint: bool = False
    typecheck: bool = False
    compile: bool = False


class VerificationResultPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    status: Literal["passed", "failed", "unavailable"]
    commands_run: list[CommandResult] = Field(default_factory=list)
    coverage: CoverageMap = Field(default_factory=CoverageMap)
    evidence_files: list[str] = Field(default_factory=list)
    # Required when status == "unavailable" — the spec wants an explicit reason
    # so reviewers can decide whether the gap is acceptable.
    reason: str | None = None
    fallback_checks: list[str] = Field(default_factory=list)


class VerificationReceipt(_ReceiptBase):
    """Spec §7.4 verify output. Mandatory for stage approval."""

    kind: Literal[ReceiptKind.VERIFICATION] = ReceiptKind.VERIFICATION
    verification_result: VerificationResultPayload


# ─── REPAIR ──────────────────────────────────────────────────────────────────


class RepairReceipt(_ReceiptBase):
    """Spec §7.5 repair output."""

    kind: Literal[ReceiptKind.REPAIR] = ReceiptKind.REPAIR
    retry_number: int = Field(..., ge=1)
    failure_summary: str
    repair_hypothesis: str
    files_to_reinspect: list[str] = Field(default_factory=list)
    edits: list[EditEntry] = Field(default_factory=list)
    expected_fix: str | None = None


# ─── SELF_REVIEW ─────────────────────────────────────────────────────────────


class AcceptanceCheck(BaseModel):
    model_config = ConfigDict(extra="allow")
    criterion: str
    status: Literal["met", "not_met", "uncertain"]
    evidence: str | None = None


class RiskSummary(BaseModel):
    model_config = ConfigDict(extra="allow")
    risk_level: Literal["low", "medium", "high"] = "low"
    risks: list[str] = Field(default_factory=list)
    rollback_notes: str | None = None


class DiffSummary(BaseModel):
    model_config = ConfigDict(extra="allow")
    files_changed: list[str] = Field(default_factory=list)
    lines_added: int = 0
    lines_deleted: int = 0
    notable_changes: list[str] = Field(default_factory=list)


class SelfReviewReceipt(_ReceiptBase):
    """Spec §7.6 self-review output. Gates the approval gate."""

    kind: Literal[ReceiptKind.SELF_REVIEW] = ReceiptKind.SELF_REVIEW
    summary: str = ""
    acceptance_criteria_check: list[AcceptanceCheck] = Field(default_factory=list)
    risk_summary: RiskSummary = Field(default_factory=RiskSummary)
    diff_summary: DiffSummary = Field(default_factory=DiffSummary)
    verification_summary: str = ""
    recommended_for_approval: bool = False


# ─── APPROVAL (workgraph-api stamps these, not the agent) ────────────────────


class ApprovalReceipt(_ReceiptBase):
    """Spec §17.4. Persisted when a human approves a stage. Not produced by
    the agent — workgraph-api builds this from the approval form."""

    kind: Literal[ReceiptKind.APPROVAL] = ReceiptKind.APPROVAL
    decision: Literal["approved", "changes_requested", "rejected"]
    approver: str
    comments: str | None = None
    approved_actions: list[str] = Field(default_factory=list)
    blocked_actions: list[str] = Field(default_factory=list)


# ─── Phase → receipt lookup ──────────────────────────────────────────────────


_PHASE_TO_MODEL: dict[Phase, type[_ReceiptBase]] = {
    Phase.PLAN: PlanReceipt,
    Phase.EXPLORE: ContextReceipt,
    Phase.ACT: EditReceipt,
    Phase.VERIFY: VerificationReceipt,
    Phase.REPAIR: RepairReceipt,
    Phase.SELF_REVIEW: SelfReviewReceipt,
    # FINALIZE doesn't carry a receipt of its own — finalize-time artifacts
    # (branch SHA, commit SHA, PR URL) are returned in the response body but
    # don't flow through this validator pipeline.
}


def receipt_for_phase(phase: Phase) -> type[_ReceiptBase] | None:
    """Return the Pydantic model the validator should use for `phase`, or
    None for phases that don't emit a structured receipt (FINALIZE)."""
    return _PHASE_TO_MODEL.get(phase)
