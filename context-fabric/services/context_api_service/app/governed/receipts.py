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

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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
    # Non-code stages run under the same governed loop but produce wholly
    # different artifacts. Story intake (PRODUCT_OWNER) writes a narrative
    # brief + acceptance criteria, not file edits.
    STORY_INTAKE = "story_intake_receipt"
    STORY_INTAKE_REVIEW = "story_intake_review_receipt"


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
    """Spec §7.1 plan output.

    M72 Slice B — gains optional `config_inspected_files` (max 1 entry).
    Used by multi-module-repo plans that legitimately need to peek at one
    config file (settings.gradle.kts, pom.xml, pyproject.toml) to
    disambiguate the layout before producing target_files. The validator
    enforces the soft cap; broader reads belong in EXPLORE.
    """

    kind: Literal[ReceiptKind.PLAN] = ReceiptKind.PLAN
    target_files: list[str] = Field(..., description="Files the agent expects to touch.")
    expected_edits: list[dict[str, Any]] = Field(default_factory=list)
    symbols_to_inspect: list[str] = Field(default_factory=list)
    test_strategy: TestStrategy
    risk_level: Literal["low", "medium", "high"] = "low"
    external_side_effects_required: bool = False
    assumptions: list[str] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    # M72B — optional, capped at max_length=1. Field(default_factory=list)
    # rather than Optional[...] keeps the validator-side check uniform with
    # the StagePolicy.requiredOutputSchema (which uses maxItems: 1).
    config_inspected_files: list[str] = Field(default_factory=list, max_length=1)


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


class SkippedTarget(BaseModel):
    """M74 Phase 1B — agent's explicit declaration that a PlanReceipt
    target_file was deliberately not edited. Used by the path-coverage
    check in loop.py to allow legitimate scope reductions without
    refusing the ACT→VERIFY advance.

    Example reasons: "test file regenerated by build, no manual edit",
    "no longer needed after refactor consolidated logic into base.py",
    "deferred to follow-up issue per discovered scope expansion".
    """
    model_config = ConfigDict(extra="allow")
    file: str
    reason: str


class EditReceipt(_ReceiptBase):
    """Spec §7.3 act output."""

    kind: Literal[ReceiptKind.EDIT] = ReceiptKind.EDIT
    edits: list[EditEntry] = Field(..., min_length=1)
    # M74 Phase 1B — when the agent legitimately chose not to edit a
    # PlanReceipt.target_files entry, declare it here with a reason.
    # The path-coverage check (loop.py, ACT→VERIFY advance) refuses to
    # advance if any plan target is neither in edits[].file nor in
    # skipped_targets[].file. Empty list is fine when the EditReceipt
    # fully covers the plan.
    skipped_targets: list[SkippedTarget] = Field(default_factory=list)


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

    # M74 Phase 1C — close the fake-pass loophole. Under the old shape an
    # agent could submit `{status: "passed", commands_run: []}` and have
    # the phase machine happily advance to SELF_REVIEW with zero evidence
    # that any verifier actually ran. The schema was structurally valid
    # because commands_run had a default. Now it's structurally required
    # for passed/failed — only "unavailable" can have an empty list (and
    # that path requires `reason` to be set, enforced just below).
    @model_validator(mode="after")
    def _passed_or_failed_requires_commands(self) -> "VerificationResultPayload":
        if self.status in ("passed", "failed") and not self.commands_run:
            raise ValueError(
                f"VerificationResultPayload: status={self.status!r} requires "
                "commands_run to be non-empty — at least one command must have "
                "been executed to substantiate the verdict. If no verifier "
                "could be run, set status='unavailable' with a `reason`."
            )
        # Fix (review issue #5, 2026-05-23) — close the
        # "confidently-wrong" loophole. The Phase 1C validator above
        # only checked that commands_run was non-empty; it didn't
        # check the exit codes. A model could submit
        # status='passed' alongside a CommandResult with exit_code=1
        # and the receipt would validate, letting it bypass the
        # verification gate and advance to SELF_REVIEW with failing
        # tests. Now: if status is 'passed', every command in
        # commands_run must have exit_code == 0. If any failed, the
        # correct status is 'failed' (which advances to REPAIR
        # under the phase machine's verify→repair edge).
        if self.status == "passed":
            failed = [c.command for c in self.commands_run if c.exit_code != 0]
            if failed:
                raise ValueError(
                    "VerificationResultPayload: status cannot be 'passed' when "
                    f"underlying verifiers returned non-zero exit codes for: "
                    f"{failed!r}. Either set status='failed' (advances to REPAIR), "
                    "or fix the failing commands and re-run."
                )
        if self.status == "unavailable" and not (self.reason and self.reason.strip()):
            raise ValueError(
                "VerificationResultPayload: status='unavailable' requires a "
                "non-empty `reason` so reviewers can decide whether the gap is "
                "acceptable. Examples: 'no test framework configured', "
                "'verifier-registry returned no candidates for changed paths'."
            )
        return self


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

    @field_validator("files_changed", mode="before")
    @classmethod
    def _coerce_files_changed(cls, v: Any) -> Any:
        """The prompt example historically showed `files_changed: 0` (an int),
        so some agents emit a count instead of a list of paths. Coerce common
        misshapes into a list so a long-running stage doesn't get stranded
        in SELF_REVIEW on a cosmetic schema mismatch (M76 postmortem). The
        downstream consumers all treat this as an audit/UI list — if the
        agent passed a count we just don't have paths to show; we don't fail.
        """
        if v is None:
            return []
        if isinstance(v, list):
            return v
        if isinstance(v, int):
            return []  # legacy count-shape: drop the count, keep the list empty
        if isinstance(v, str):
            return [v]  # single path passed unwrapped
        if isinstance(v, dict):
            # tolerate {"count": N, "paths": [...]} or {"paths": [...]}
            paths = v.get("paths") or v.get("files") or []
            return paths if isinstance(paths, list) else []
        return []  # unknown shape — degrade to empty rather than 400


class SelfReviewReceipt(_ReceiptBase):
    """Spec §7.6 self-review output. Gates the approval gate."""

    kind: Literal[ReceiptKind.SELF_REVIEW] = ReceiptKind.SELF_REVIEW
    summary: str = ""
    acceptance_criteria_check: list[AcceptanceCheck] = Field(default_factory=list)
    risk_summary: RiskSummary = Field(default_factory=RiskSummary)
    diff_summary: DiffSummary = Field(default_factory=DiffSummary)
    verification_summary: str = ""
    recommended_for_approval: bool = False

    # M73-followup #4 — confidently-wrong agents will mark their own work
    # `recommended_for_approval=True` even when their own acceptance-criteria
    # checks contradict that. The human-approval gate downstream is meant to
    # catch this, but the model's recommendation is what the gate's pre-fill
    # state and the workbench's "ready to approve" banner key off — so a
    # falsely-true recommendation poisons the operator's first-impression UX.
    #
    # Refuse the receipt at the model boundary:
    #   • If ANY criterion has status="not_met" → recommended_for_approval
    #     MUST be False. Hard refuse.
    #   • If >=2 criteria have status="uncertain" → ditto. Two unknowns is
    #     enough doubt that the agent shouldn't be self-certifying.
    #
    # The agent can still complete SELF_REVIEW phase — it just has to flip
    # the recommendation to False (and the workbench will render the partial
    # evidence accordingly). This is structural, not advisory.
    @model_validator(mode="after")
    def _refuse_inconsistent_recommendation(self) -> "SelfReviewReceipt":
        if not self.recommended_for_approval:
            return self
        not_met = [c.criterion for c in self.acceptance_criteria_check if c.status == "not_met"]
        if not_met:
            raise ValueError(
                "SelfReviewReceipt: recommended_for_approval=True is forbidden "
                f"when any acceptance criterion is not_met (failing: {not_met!r}). "
                "Set recommended_for_approval=False and let the human gate decide."
            )
        uncertain = [c.criterion for c in self.acceptance_criteria_check if c.status == "uncertain"]
        if len(uncertain) >= 2:
            raise ValueError(
                "SelfReviewReceipt: recommended_for_approval=True is forbidden "
                f"when 2 or more acceptance criteria are uncertain (uncertain: {uncertain!r}). "
                "Either provide evidence or set recommended_for_approval=False."
            )
        return self


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


# ─── Story-intake receipts (PRODUCT_OWNER stage) ─────────────────────────────


class StoryIntakeReceipt(_ReceiptBase):
    """Spec §17 — PRODUCT_OWNER intake output.

    Runs in the PLAN phase slot but produces a wholly different shape from
    the code-stage PlanReceipt: a narrative story brief, acceptance
    criteria, and clarification questions. No code, no file targets, no
    test strategy. Used by `validators.py` when the stage's agent_role is
    PRODUCT_OWNER.

    The 2026-05-24 RCA caught this gap: the loop validator was always
    routing PLAN payloads to PlanReceipt, so PRODUCT_OWNER stages couldn't
    advance no matter how well-formed the intake output was.
    """

    kind: Literal[ReceiptKind.STORY_INTAKE] = ReceiptKind.STORY_INTAKE
    story_brief: str = Field(
        ...,
        min_length=1,
        description="Markdown narrative of the user story, value, scope.",
    )
    acceptance_criteria: list[str] = Field(
        ...,
        min_length=1,
        description="Discrete pass/fail conditions for the feature.",
    )
    open_questions: list[str] = Field(
        default_factory=list,
        description="Clarification questions that block planning.",
    )

    @model_validator(mode="before")
    @classmethod
    def _coerce_intake_shapes(cls, data: Any) -> Any:
        """(2026-05-25) Lenient coercion for over-structured model output.

        Claude haiku 4.5 (and other models) interpret "structured story
        intake" too literally and emit every field as a richly-annotated
        object instead of the flat type the schema declares. Two
        observed failure modes in production:

          1. `open_questions` / `acceptance_criteria` as
             `list[dict]` instead of `list[str]` — model attaches
             `{question, priority, area}` metadata to each item.

          2. `story_brief` as `dict` instead of `str` — model emits
             `{markdown, sections, summary}` instead of a flat string.

        Both cases: the model's intent is clear and the metadata is
        harmless to drop or stringify. Force the schema-declared shape
        on the way in so validation can proceed; we'd rather lose
        annotation than fail the whole stage.

        For `acceptance_criteria` specifically, ALSO check common
        synonym keys (`acceptanceCriteria`, `acceptance_contract`,
        `criteria`) when the canonical field is missing — operators
        change prompt wording, models follow, schema needs to keep up.
        """
        if not isinstance(data, dict):
            return data
        import json as _json

        # --- list-shape coercion (open_questions, acceptance_criteria) ---
        def _dict_to_text(item: dict) -> str:
            for key in (
                "question", "text", "content", "criterion",
                "description", "value", "title", "name", "summary",
            ):
                v = item.get(key)
                if isinstance(v, str) and v.strip():
                    return v
            return _json.dumps(item, separators=(",", ":"))

        def _coerce_to_str_list(raw: Any) -> list[str] | None:
            if not isinstance(raw, list):
                return None
            out: list[str] = []
            for item in raw:
                if item is None or item == "":
                    continue
                if isinstance(item, str):
                    out.append(item)
                elif isinstance(item, dict):
                    out.append(_dict_to_text(item))
                else:
                    out.append(str(item))
            return out

        # acceptance_criteria — pull from common synonyms if missing, and
        # also unwrap from a wrapping dict (acceptance_contract={criteria:[...]})
        # because operators set `acceptance_contract` as the artifact name
        # and models echo that label.
        if not isinstance(data.get("acceptance_criteria"), list):
            found = False
            for syn in ("acceptanceCriteria", "acceptance_contract",
                        "acceptanceContract", "criteria", "criterions",
                        "passConditions", "pass_conditions"):
                v = data.get(syn)
                if isinstance(v, list):
                    data["acceptance_criteria"] = v
                    found = True
                    break
                if isinstance(v, dict):
                    # Unwrap a wrapper object: pull the first list-valued
                    # field whose key suggests criteria-ness.
                    for inner_key in (
                        "criteria", "items", "list", "acceptance_criteria",
                        "conditions", "checks", "examples",
                    ):
                        inner = v.get(inner_key)
                        if isinstance(inner, list):
                            data["acceptance_criteria"] = inner
                            found = True
                            break
                    if found:
                        break
                if isinstance(v, str) and v.strip():
                    # Operator passed a single string as the contract — split
                    # on newlines / bullets to recover individual criteria.
                    import re as _re
                    split = [
                        s.strip().lstrip("-*•").strip()
                        for s in _re.split(r"\n+", v)
                        if s.strip()
                    ]
                    if split:
                        data["acceptance_criteria"] = split
                        found = True
                        break

        for field_name in ("open_questions", "acceptance_criteria"):
            coerced = _coerce_to_str_list(data.get(field_name))
            if coerced is not None:
                data[field_name] = coerced

        # --- story_brief: dict → string ---
        sb = data.get("story_brief")
        if isinstance(sb, dict):
            # Prefer markdown / content / summary / body / text keys.
            for key in ("markdown", "content", "summary", "body", "text",
                        "narrative", "brief"):
                v = sb.get(key)
                if isinstance(v, str) and v.strip():
                    data["story_brief"] = v
                    break
            else:
                # No known key — assemble a markdown-ish dump of all
                # string fields so the brief content isn't lost.
                lines: list[str] = []
                for k, v in sb.items():
                    if isinstance(v, str) and v.strip():
                        lines.append(f"### {k}\n{v}")
                if lines:
                    data["story_brief"] = "\n\n".join(lines)
                else:
                    # Last resort: serialize the whole object.
                    data["story_brief"] = _json.dumps(sb, indent=2)
        elif isinstance(sb, list):
            # Some models emit story_brief as a list of paragraphs.
            data["story_brief"] = "\n\n".join(
                str(p) for p in sb if p is not None and p != ""
            )
        # If story_brief is missing entirely, try common aliases.
        if not data.get("story_brief"):
            for syn in ("storyBrief", "story", "brief", "narrative",
                        "summary", "description"):
                v = data.get(syn)
                if isinstance(v, str) and v.strip():
                    data["story_brief"] = v
                    break
                if isinstance(v, dict):
                    # Recurse: treat the syn-value the same way.
                    inner = v.get("markdown") or v.get("content") or v.get("text")
                    if isinstance(inner, str) and inner.strip():
                        data["story_brief"] = inner
                        break
        return data


class StoryIntakeReviewReceipt(_ReceiptBase):
    """PRODUCT_OWNER's SELF_REVIEW output.

    Smaller than the developer SelfReviewReceipt — the intake reviewer
    only attests that the brief is ready (or not) for the planning stage
    to consume.

    Permissive on purpose. The workbench always gates intake on a HUMAN
    approval card after the model emits this receipt (gateMode=manual
    in the loop definition), so the receipt's role is purely to signal
    "model finished reviewing" — not to make the final pass/fail call.
    Treat any non-empty review submission as `recommended_for_approval=True`
    by default; the human can still send back, reject, or edit during
    the manual approval step.

    Coercion order (most→least specific):
      1. Explicit `recommended_for_approval: bool` wins (operator
         opt-out, even if the verdict text looks positive).
      2. Legacy verdict keys `gate_recommendation` / `recommendation` /
         `verdict` / `approval` → bool via the PASS|NEEDS_REWORK|BLOCKED
         vocabulary the original PRODUCT_OWNER prompt has carried since
         M71.
      3. Anything else → default to True. The 2026-05-24 RCA observed
         haiku 4.5 producing a `risk_summary`-only payload (no verdict
         field at all) on the SELF_REVIEW phase because it got confused
         about which phase it was in; rather than block the whole
         stage on prompt-following noise from a model that's already
         done the work, we let it through to the human.
    """

    kind: Literal[ReceiptKind.STORY_INTAKE_REVIEW] = ReceiptKind.STORY_INTAKE_REVIEW
    recommended_for_approval: bool = Field(
        default=True,
        description=(
            "True when the story brief is ready for ARCHITECT planning. "
            "Defaults to True because the human approval gate downstream "
            "is the binding decision; the receipt just records the model's "
            "self-assessment."
        ),
    )
    risk_summary: dict[str, Any] = Field(
        default_factory=dict,
        description="Structured note on outstanding risks / blockers.",
    )

    @model_validator(mode="before")
    @classmethod
    def _coerce_gate_recommendation(cls, data: Any) -> Any:
        """Map legacy verdict keys onto the canonical bool when the model
        skipped `recommended_for_approval`. Falls through to the field
        default (True) when no verdict is present at all.
        """
        if not isinstance(data, dict):
            return data
        if "recommended_for_approval" in data and data["recommended_for_approval"] is not None:
            return data
        # Try a wider set of legacy keys. Different prompt revisions and
        # different models settle on different vocabulary.
        verdict = (
            data.get("gate_recommendation")
            or data.get("recommendation")
            or data.get("verdict")
            or data.get("approval")
            or data.get("review_verdict")
            or data.get("ready_for_approval")
        )
        if isinstance(verdict, bool):
            data["recommended_for_approval"] = verdict
        elif isinstance(verdict, str):
            verdict_upper = verdict.strip().upper()
            if verdict_upper in {"PASS", "APPROVE", "APPROVED", "READY", "YES", "TRUE"}:
                data["recommended_for_approval"] = True
            elif verdict_upper in {"NEEDS_REWORK", "BLOCKED", "FAIL", "REJECT", "REJECTED", "NO", "FALSE"}:
                data["recommended_for_approval"] = False
        # If we still didn't resolve a verdict, the Field default (True)
        # applies — the human approver is the real gate.
        return data


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


class ReviewPlanReceipt(_ReceiptBase):
    """PLAN-phase output for reviewer roles (SECURITY, DEVOPS) where the
    stage doesn't run tests.

    The canonical PlanReceipt mandates `test_strategy.commands` because
    DEVELOPER stages must declare what they'll verify in VERIFY. Security
    audits and release-readiness reviews don't run a test suite — they
    inspect code, dependencies, SBOMs, deployment configs. Forcing them
    to invent a `commands` array they don't use produces "PlanReceipt
    validation failed" loops where the agent can't make progress
    (2026-05-26 RCA on session ef0e849e at security-review).

    Schema differences from PlanReceipt:
      - target_files: still required (must declare review scope)
      - test_strategy: OPTIONAL (None when the stage is review-only)
      - review_strategy: NEW, optional structured field for what they'll
                         actually inspect (SAST/dependency scan/etc.)
      - everything else: same shape and defaults
    """
    model_config = ConfigDict(extra="allow")

    kind: Literal[ReceiptKind.PLAN] = ReceiptKind.PLAN
    target_files: list[str] = Field(..., description="Files in scope for review.")
    expected_edits: list[dict[str, Any]] = Field(default_factory=list)
    symbols_to_inspect: list[str] = Field(default_factory=list)
    # Optional for reviewers. Permissive coercion in case the agent
    # supplies `{"commands": []}` — a TestStrategy with min_length=1 would
    # reject that. Treat empty as "no tests for this stage".
    test_strategy: TestStrategy | None = None
    review_strategy: dict[str, Any] | None = Field(
        default=None,
        description="Optional structured plan: approach, scanners, focus areas.",
    )
    risk_level: Literal["low", "medium", "high"] = "low"
    external_side_effects_required: bool = False
    assumptions: list[str] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    config_inspected_files: list[str] = Field(default_factory=list, max_length=1)

    @field_validator("test_strategy", mode="before")
    @classmethod
    def _empty_strategy_to_none(cls, v: Any) -> Any:
        """Reviewer agents sometimes emit `{commands: []}` literally, which
        TestStrategy.min_length=1 would reject. Coerce empty → None."""
        if v is None:
            return None
        if isinstance(v, dict):
            cmds = v.get("commands")
            if not isinstance(cmds, list) or len(cmds) == 0:
                return None
        return v

    @field_validator("target_files", mode="before")
    @classmethod
    def _coerce_target_files(cls, v: Any) -> Any:
        """Agents commonly emit target_files as a list of structured
        objects describing each file under review (e.g.
        `[{file: "x.java", reason: "auth check"}, ...]`) rather than
        flat path strings. Extract the path from common keys instead
        of rejecting. Same pattern as DiffSummary.files_changed (M76).

        Also tolerate a single string passed unwrapped, which a few
        agent runs have produced when they only have one target."""
        if v is None:
            return []
        if isinstance(v, str):
            return [v]
        if isinstance(v, dict):
            # Reviewer agents have produced single-file payloads like
            # {file: "x", reason: "y"} or {paths: ["a", "b"]}.
            paths = v.get("paths") or v.get("files")
            if isinstance(paths, list):
                return [p for p in paths if isinstance(p, str) and p.strip()]
            single = v.get("file") or v.get("path") or v.get("name")
            if isinstance(single, str) and single.strip():
                return [single]
            return []
        if not isinstance(v, list):
            return []
        out: list[str] = []
        for item in v:
            if isinstance(item, str) and item.strip():
                out.append(item)
            elif isinstance(item, dict):
                # Per-item structured shapes — extract the path string.
                # Most commonly: {file: "x", reason: "y"} or
                # {path: "x", concern: "y"}.
                single = item.get("file") or item.get("path") or item.get("name") or item.get("target")
                if isinstance(single, str) and single.strip():
                    out.append(single)
            # Skip anything else (numbers, nulls, nested lists) — preserves
            # the rest of the receipt rather than rejecting the whole turn.
        return out

    @field_validator("open_questions", mode="before")
    @classmethod
    def _coerce_open_questions(cls, v: Any) -> Any:
        """Agents commonly emit `open_questions` in non-list shapes:
            - a single string (one question)
            - a single dict {question, blocking}
            - a list of dicts (per-question metadata)
        Coerce all into list[str] — the question text is what matters for
        the audit trail. Structured per-question metadata can be
        reattached via `extra="allow"` fields if a downstream consumer
        needs it."""
        if v is None:
            return []
        if isinstance(v, str):
            return [v] if v.strip() else []
        if isinstance(v, dict):
            # Single-question dict shape.
            q = v.get("question") or v.get("text") or v.get("prompt")
            return [q] if isinstance(q, str) and q.strip() else []
        if not isinstance(v, list):
            return []
        out: list[str] = []
        for item in v:
            if isinstance(item, str) and item.strip():
                out.append(item)
            elif isinstance(item, dict):
                q = item.get("question") or item.get("text") or item.get("prompt")
                if isinstance(q, str) and q.strip():
                    out.append(q)
            # Skip anything else silently.
        return out


# Stage-specific overrides. Keyed by (agent_role, phase) — when the loop
# validator sees a stage whose policy declares one of these agent roles
# AND the current phase is in this map, it uses the override instead of
# the canonical _PHASE_TO_MODEL entry. Anything not listed here falls
# through to the default.
#
# Today this carries the PRODUCT_OWNER → story-intake mapping; future
# non-code stage families (e.g. RELEASE → release-notes receipt) plug in
# the same way without touching the validators.
_AGENT_ROLE_PHASE_OVERRIDES: dict[tuple[str, Phase], type[_ReceiptBase]] = {
    ("PRODUCT_OWNER", Phase.PLAN): StoryIntakeReceipt,
    ("PRODUCT_OWNER", Phase.SELF_REVIEW): StoryIntakeReviewReceipt,
    # M79 (2026-05-26) — reviewer roles where test_strategy is optional.
    ("SECURITY", Phase.PLAN): ReviewPlanReceipt,
    ("DEVOPS",   Phase.PLAN): ReviewPlanReceipt,
}


def receipt_for_phase(
    phase: Phase, agent_role: str | None = None
) -> type[_ReceiptBase] | None:
    """Return the Pydantic model the validator should use for `phase`, or
    None for phases that don't emit a structured receipt (FINALIZE).

    When `agent_role` is supplied AND (agent_role, phase) appears in the
    overrides table, the override wins. This lets non-code stages
    (PRODUCT_OWNER intake, future RELEASE notes, etc.) reuse the same
    phase slots without having to share the developer-receipt shape.
    """
    if agent_role:
        override = _AGENT_ROLE_PHASE_OVERRIDES.get((agent_role, phase))
        if override is not None:
            return override
    return _PHASE_TO_MODEL.get(phase)
