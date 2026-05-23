"""
M71 — Receipt validator unit tests.

Covers:
  * Each phase's canonical Pydantic shape (happy path + missing-required).
  * The light JSON-schema-ish overlay from StagePolicy.requiredOutputSchema.
  * The structured error shape returned via PhaseOutputInvalid.to_dict().
"""
import pytest

from context_api_service.app.governed.phase_state import Phase
from context_api_service.app.governed.policy_loader import PhasePolicy, StagePolicy
from context_api_service.app.governed.validators import (
    PhaseOutputInvalid,
    validate_phase_output,
)


# ── helpers ─────────────────────────────────────────────────────────────────


def _policy_with_phase(phase: Phase, required_schema: dict | None = None) -> StagePolicy:
    """Minimal StagePolicy carrying a single phase row with `required_schema`."""
    pp = PhasePolicy(
        phase=phase,
        allowed_tools=frozenset(),
        forbidden_tools=frozenset(),
        required_output_schema=required_schema or {},
        max_input_tokens=None,
        max_output_tokens=None,
        max_tool_calls=None,
    )
    return StagePolicy(
        policy_id="t",
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        version=1,
        status="ACTIVE",
        approval_model={},
        limits={},
        context_policy={},
        edit_policy={},
        verification_policy={},
        risk_policy={},
        phases={phase: pp},
    )


# ── PLAN ────────────────────────────────────────────────────────────────────


def test_plan_receipt_happy_path():
    """A complete PLAN payload validates and stamps `kind`+`created_at`."""
    payload = {
        "target_files": ["a.py"],
        "test_strategy": {"commands": ["pytest tests/"]},
        "risk_level": "low",
    }
    parsed = validate_phase_output(Phase.PLAN, payload)
    assert parsed["kind"] == "plan_receipt"
    assert parsed["target_files"] == ["a.py"]
    assert "created_at" in parsed


def test_plan_receipt_missing_test_strategy_fails():
    """test_strategy is mandatory per spec §7.1."""
    with pytest.raises(PhaseOutputInvalid) as exc:
        validate_phase_output(Phase.PLAN, {"target_files": ["a.py"]})
    fields = {d["field"] for d in exc.value.details}
    assert "test_strategy" in fields


def test_plan_receipt_empty_commands_fails():
    """test_strategy.commands must have at least one command (min_length=1)."""
    with pytest.raises(PhaseOutputInvalid):
        validate_phase_output(
            Phase.PLAN,
            {"target_files": ["a.py"], "test_strategy": {"commands": []}},
        )


def test_plan_receipt_accepts_one_config_file():
    """M72B — multi-module repos can read ONE config to disambiguate layout."""
    payload = {
        "target_files": ["RuleEngine/src/.../Operator.java"],
        "test_strategy": {"commands": ["mvn -pl RuleEngine test"]},
        "risk_level": "low",
        "config_inspected_files": ["RuleEngine/pom.xml"],
    }
    parsed = validate_phase_output(Phase.PLAN, payload)
    assert parsed["config_inspected_files"] == ["RuleEngine/pom.xml"]


def test_plan_receipt_rejects_two_config_files():
    """M72B — the soft cap is 1. Two entries means the agent should have
    moved to EXPLORE; the validator catches it before it becomes a habit."""
    payload = {
        "target_files": ["a.py"],
        "test_strategy": {"commands": ["pytest"]},
        "risk_level": "low",
        "config_inspected_files": ["pom.xml", "build.gradle.kts"],
    }
    with pytest.raises(PhaseOutputInvalid) as exc:
        validate_phase_output(Phase.PLAN, payload)
    # The field-level error should mention the cap so the LLM knows what to fix.
    fields = {d["field"] for d in exc.value.details}
    assert any("config_inspected_files" in f for f in fields)


def test_plan_receipt_config_files_default_empty():
    """Backward-compat: PLAN receipts that don't mention config_inspected_files
    still pass — the field is optional with default []."""
    payload = {
        "target_files": ["a.py"],
        "test_strategy": {"commands": ["pytest"]},
        "risk_level": "low",
    }
    parsed = validate_phase_output(Phase.PLAN, payload)
    assert parsed["config_inspected_files"] == []


# ── VERIFY ─────────────────────────────────────────────────────────────────


def test_verification_receipt_passed():
    payload = {
        "verification_result": {
            "status": "passed",
            "commands_run": [{"command": "pytest", "exit_code": 0}],
        }
    }
    parsed = validate_phase_output(Phase.VERIFY, payload)
    assert parsed["kind"] == "verification_receipt"
    assert parsed["verification_result"]["status"] == "passed"


def test_verification_receipt_bad_status_fails():
    """status must be one of passed|failed|unavailable."""
    with pytest.raises(PhaseOutputInvalid):
        validate_phase_output(
            Phase.VERIFY, {"verification_result": {"status": "kinda_worked"}}
        )


# ── ACT / EDIT ──────────────────────────────────────────────────────────────


def test_edit_receipt_requires_at_least_one_edit():
    """An ACT phase with no edits is meaningless; the receipt enforces it."""
    with pytest.raises(PhaseOutputInvalid):
        validate_phase_output(Phase.ACT, {"edits": []})


def test_edit_receipt_rejects_unknown_edit_type():
    """edit_type is an enum — spec §7.3."""
    with pytest.raises(PhaseOutputInvalid):
        validate_phase_output(
            Phase.ACT,
            {"edits": [{"file": "a.py", "edit_type": "shell_eval", "reason": "no"}]},
        )


# ── SELF_REVIEW ─────────────────────────────────────────────────────────────


def test_self_review_recommended_for_approval_round_trips():
    payload = {
        "recommended_for_approval": True,
        "acceptance_criteria_check": [
            {"criterion": "tests pass", "status": "met", "evidence": "pytest exit 0"}
        ],
    }
    parsed = validate_phase_output(Phase.SELF_REVIEW, payload)
    assert parsed["recommended_for_approval"] is True
    assert parsed["acceptance_criteria_check"][0]["status"] == "met"


def test_self_review_rejects_invalid_acceptance_status():
    with pytest.raises(PhaseOutputInvalid):
        validate_phase_output(
            Phase.SELF_REVIEW,
            {
                "acceptance_criteria_check": [
                    {"criterion": "x", "status": "maybe"}
                ]
            },
        )


# M73-followup #4 — recommended_for_approval must agree with the criteria.
# A confidently-wrong agent can't self-certify when its own checks contradict
# the recommendation.

def test_self_review_rejects_approval_with_any_not_met():
    """recommended_for_approval=True + any criterion not_met → refuse.
    Hard structural rule, not advisory."""
    with pytest.raises(PhaseOutputInvalid):
        validate_phase_output(
            Phase.SELF_REVIEW,
            {
                "recommended_for_approval": True,
                "acceptance_criteria_check": [
                    {"criterion": "tests pass", "status": "met"},
                    {"criterion": "no regressions", "status": "not_met",
                     "evidence": "two pre-existing tests now fail"},
                ],
            },
        )


def test_self_review_rejects_approval_with_two_uncertain():
    """≥2 uncertain criteria → refuse approval recommendation. Two unknowns
    is enough doubt that the agent shouldn't self-certify."""
    with pytest.raises(PhaseOutputInvalid):
        validate_phase_output(
            Phase.SELF_REVIEW,
            {
                "recommended_for_approval": True,
                "acceptance_criteria_check": [
                    {"criterion": "performance baseline", "status": "uncertain"},
                    {"criterion": "downstream impact", "status": "uncertain"},
                ],
            },
        )


def test_self_review_accepts_approval_with_one_uncertain():
    """One uncertain is fine — that's a common state for soft criteria
    (e.g. "matches design intent"). Two is where we refuse."""
    parsed = validate_phase_output(
        Phase.SELF_REVIEW,
        {
            "recommended_for_approval": True,
            "acceptance_criteria_check": [
                {"criterion": "tests pass", "status": "met"},
                {"criterion": "matches design intent", "status": "uncertain"},
            ],
        },
    )
    assert parsed["recommended_for_approval"] is True


def test_self_review_accepts_not_recommended_with_failures():
    """The agent CAN still complete SELF_REVIEW when criteria fail — it
    just has to flip recommended_for_approval to False. Verifying that
    the validator doesn't refuse non-recommendation cases."""
    parsed = validate_phase_output(
        Phase.SELF_REVIEW,
        {
            "recommended_for_approval": False,
            "acceptance_criteria_check": [
                {"criterion": "tests pass", "status": "not_met"},
            ],
        },
    )
    assert parsed["recommended_for_approval"] is False


# ── policy-schema overlay ──────────────────────────────────────────────────


def test_policy_required_field_layer_blocks_missing_extra():
    """StagePolicy can demand fields beyond the Pydantic shape — e.g. a project
    that wants `mitigation_for_regression_risk` on every PLAN receipt."""
    policy = _policy_with_phase(
        Phase.PLAN,
        required_schema={"required": ["mitigation_for_regression_risk"]},
    )
    base = {
        "target_files": ["a.py"],
        "test_strategy": {"commands": ["pytest"]},
        "risk_level": "low",
    }
    with pytest.raises(PhaseOutputInvalid) as exc:
        validate_phase_output(Phase.PLAN, base, policy=policy)
    fields = {d["field"] for d in exc.value.details}
    assert "mitigation_for_regression_risk" in fields


def test_policy_required_field_layer_passes_when_present():
    policy = _policy_with_phase(
        Phase.PLAN,
        required_schema={"required": ["mitigation_for_regression_risk"]},
    )
    payload = {
        "target_files": ["a.py"],
        "test_strategy": {"commands": ["pytest"]},
        "risk_level": "low",
        "mitigation_for_regression_risk": "covered by existing regression suite",
    }
    parsed = validate_phase_output(Phase.PLAN, payload, policy=policy)
    assert parsed["mitigation_for_regression_risk"] == "covered by existing regression suite"


# ── error shape ────────────────────────────────────────────────────────────


def test_phase_output_invalid_to_dict_shape():
    """Wire shape must include error_code + per-field details so the LLM
    knows what to fix."""
    with pytest.raises(PhaseOutputInvalid) as exc:
        validate_phase_output(Phase.PLAN, {"target_files": ["a.py"]})
    body = exc.value.to_dict()
    assert body["error_code"] == "PHASE_OUTPUT_INVALID"
    assert body["phase"] == "PLAN"
    assert isinstance(body["details"], list)
    assert all("field" in d for d in body["details"])


# ── FINALIZE — no receipt model, payload echoed back ───────────────────────


def test_finalize_has_no_receipt_model_but_doesnt_raise():
    """FINALIZE doesn't have a canonical receipt — the validator must
    accept it and echo the payload back with a kind hint."""
    payload = {"branch_name": "sg/WI-123", "commit_sha": "abc123"}
    parsed = validate_phase_output(Phase.FINALIZE, payload)
    assert parsed["kind"] == "finalize_artifact"
    assert parsed["branch_name"] == "sg/WI-123"
